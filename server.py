import flask # Not strictly necessary if Flask is imported directly
from flask import Flask, request, redirect, url_for, render_template, session, jsonify, flash
from flask_cors import CORS
import os
import sqlite3
from functools import wraps
import random
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv
# pandas and numpy are imported but not used in the provided snippet.
# If they are used elsewhere, keep them. Otherwise, they can be removed.
# import pandas as pd
# import numpy as np
# import json # Imported but not used in the provided snippet.

from flask_socketio import SocketIO, emit, join_room, leave_room # For video conferencing

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'a_very_secure_default_secret_key_123!PleaseChange')
CORS(app, supports_credentials=True) # For general HTTP CORS
socketio = SocketIO(app, cors_allowed_origins="*") # For SocketIO CORS

APP_EMAIL_SENDER = os.getenv('EMAIL_USER')
APP_EMAIL_PASSWORD = os.getenv('PASSWORD')

DB_PATH = './users.db'

# --- Video Conferencing Globals ---
video_rooms = {} # In-memory room store for video chat


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT UNIQUE NOT NULL,
                            password TEXT NOT NULL,
                            otp TEXT,
                            verified INTEGER DEFAULT 0
                        )''')
        conn.commit()
    print(f"User database initialized at {DB_PATH}")

def is_valid_email(email):
    return email and email.endswith('@cloudkeeper.com')

def send_otp_email(to_email, otp):
    if not APP_EMAIL_SENDER or not APP_EMAIL_PASSWORD:
        print("ERROR: Email credentials not configured for OTP.")
        return False
    msg = MIMEMultipart('alternative')
    msg['Subject'] = 'CloudKeeper - Your Verification OTP'
    msg['From'] = f'CloudKeeper Support <{APP_EMAIL_SENDER}>'
    msg['To'] = to_email
    text = f"Your CloudKeeper OTP is: {otp}\nValid for 10 minutes."
    html = f"""<html><body><p>Your CloudKeeper OTP is: <b>{otp}</b></p><p>Valid for 10 minutes.</p></body></html>"""
    msg.attach(MIMEText(text, 'plain'))
    msg.attach(MIMEText(html, 'html'))
    try:
        with smtplib.SMTP('smtp.gmail.com', 587) as server:
            server.starttls()
            server.login(APP_EMAIL_SENDER, APP_EMAIL_PASSWORD)
            server.sendmail(msg['From'], [msg['To']], msg.as_string())
            print(f"OTP email sent to {to_email}.")
            return True
    except Exception as e:
        print(f"Failed to send OTP to {to_email}: {e}")
        return False

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            flash("Please log in to access this page.", "warning")
            return redirect(url_for('welcome'))
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT verified FROM users WHERE username = ?", (session['username'],)).fetchone()
            if not user or not user['verified']:
                session.pop('username', None) # Log out unverified or problematic user
                flash("Account not verified. Please verify or log in again.", "danger")
                return redirect(url_for('welcome'))
        return f(*args, **kwargs)
    return decorated_function

# --- Auth Routes (New Flow) ---
@app.route('/', methods=['GET'])
def welcome():
    if 'username' in session:
        # Check if user is verified before redirecting to dashboard
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT verified FROM users WHERE username = ?", (session['username'],)).fetchone()
            if user and user['verified']:
                return redirect(url_for('video_chat_landing_page')) # Or a general dashboard
            else:
                # This case might happen if session is stale or verification was revoked
                session.pop('username', None)
                flash("Your session was invalid or account is not verified. Please log in.", "warning")
    return render_template('welcome.html')

@app.route('/handle_email', methods=['POST'])
def handle_email():
    email = request.form.get('email', '').strip().lower()
    if not is_valid_email(email):
        flash("Invalid email. Must be a @cloudkeeper.com address.", "error")
        return redirect(url_for('welcome'))

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        user = conn.execute("SELECT * FROM users WHERE username = ?", (email,)).fetchone()

    if user:
        if user['verified']:
            session['login_email'] = email # Store for password page
            return redirect(url_for('enter_password'))
        else: # User exists but not verified
            otp = str(random.randint(100000, 999999))
            # Ensure conn is still available or reopen
            with sqlite3.connect(DB_PATH) as conn_update:
                 conn_update.execute("UPDATE users SET otp = ? WHERE username = ?", (otp, email))
                 conn_update.commit()
            if send_otp_email(email, otp):
                flash("Account not verified. A new OTP has been sent to your email.", "info")
            else:
                flash("Account not verified. Failed to send OTP, please try again later.", "error")
            session['pending_verification_email'] = email
            return redirect(url_for('verify_otp_page'))
    else: # New user
        session['signup_email'] = email # Store for account creation page
        return redirect(url_for('create_account'))

@app.route('/enter_password', methods=['GET', 'POST'])
def enter_password():
    email = session.get('login_email')
    if not email:
        flash("Session expired or email not provided. Please start over.", "warning")
        return redirect(url_for('welcome'))

    if request.method == 'POST':
        password = request.form.get('password', '')
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            # !!! IMPORTANT SECURITY WARNING !!!
            # Storing and checking passwords in plain text is highly insecure.
            # Use a strong hashing algorithm like bcrypt or Argon2.
            user = conn.execute("SELECT * FROM users WHERE username = ? AND password = ?", (email, password)).fetchone()
        
        if user and user['verified']:
            session['username'] = user['username']
            session.pop('login_email', None)
            flash(f"Welcome back, {user['username']}!", "success")
            return redirect(url_for('video_chat_landing_page')) # Or a general dashboard
        elif user and not user['verified']:
            flash("Account exists but is not verified. Please verify your email.", "warning")
            session['pending_verification_email'] = email # Resend to OTP verification
            # Optionally, resend OTP here
            return redirect(url_for('verify_otp_page'))
        else:
            flash("Invalid password or account issue.", "error")
            # return render_template('enter_password.html', email=email) # Stays on page
            
    return render_template('enter_password.html', email=email)

@app.route('/create_account', methods=['GET', 'POST'])
def create_account():
    email = session.get('signup_email')
    if not email:
        flash("Session expired or email not provided for signup. Please start over.", "warning")
        return redirect(url_for('welcome'))

    if request.method == 'POST':
        password = request.form.get('password', '')
        confirm_password = request.form.get('confirm_password', '')

        if not password or len(password) < 4 : # Basic validation
            flash("Password must be at least 4 characters.", "error")
            return render_template('create_account.html', email=email)
        if password != confirm_password:
            flash("Passwords do not match.", "error")
            return render_template('create_account.html', email=email)

        otp = str(random.randint(100000, 999999))
        try:
            with sqlite3.connect(DB_PATH) as conn:
                # !!! IMPORTANT SECURITY WARNING !!!
                # Storing passwords in plain text is highly insecure.
                # Hash passwords using bcrypt or Argon2 before storing.
                conn.execute("INSERT INTO users (username, password, otp, verified) VALUES (?, ?, ?, 0)", (email, password, otp))
                conn.commit()
            
            if send_otp_email(email, otp):
                session.pop('signup_email', None)
                session['pending_verification_email'] = email
                flash("Account created. Please check your email for the OTP to verify.", "success")
                return redirect(url_for('verify_otp_page'))
            else:
                flash("Account created, but failed to send OTP. Please try verifying later or contact support.", "error")
                # Decide if user should stay here or be redirected
                return render_template('create_account.html', email=email)
        except sqlite3.IntegrityError:
            flash("This email is already registered. Please try signing in.", "error")
            session.pop('signup_email', None) # Clear signup email attempt
            return redirect(url_for('welcome'))
        except Exception as e:
            print(f"Error in create_account: {e}") # Log detailed error
            flash(f"An unexpected error occurred. Please try again.", "error") # User-friendly message
            return render_template('create_account.html', email=email)

    return render_template('create_account.html', email=email)

@app.route('/verify_otp', methods=['GET', 'POST'])
def verify_otp_page():
    # Prioritize email from POST form data if available (e.g. if resubmitting on error)
    # Fallback to session, then to an empty string if neither.
    email_for_template = request.form.get('email_for_verification_fallback', session.get('pending_verification_email', ''))

    if request.method == 'GET' and not session.get('pending_verification_email'):
        flash("No pending verification. Please start the signup or login process.", "info")
        return redirect(url_for('welcome'))
    
    if request.method == 'POST':
        otp_input = request.form.get('otp', '').strip()
        # Ensure email_to_verify_on_post is robustly fetched
        email_to_verify_on_post = request.form.get('email_for_verification_fallback', session.get('pending_verification_email', ''))

        if not email_to_verify_on_post: # Critical check
            flash("Could not determine email for OTP verification. Please start over.", "error")
            return redirect(url_for('welcome'))
        if not otp_input:
            flash("OTP is required.", "error")
            return render_template('verify.html', email=email_to_verify_on_post) # Use the email we just determined
        
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT * FROM users WHERE username = ?", (email_to_verify_on_post,)).fetchone()

            if user and not user['verified'] and user['otp'] == otp_input:
                conn.execute("UPDATE users SET verified = 1, otp = NULL WHERE username = ?", (email_to_verify_on_post,))
                conn.commit()
                session.pop('pending_verification_email', None)
                flash("Email verified successfully! Please log in.", "success")
                return redirect(url_for('welcome'))
            elif user and user['verified']: # Already verified
                session.pop('pending_verification_email', None)
                flash("This account is already verified. You can log in.", "info")
                return redirect(url_for('welcome'))
            else: # Invalid OTP or user not found (though user should exist if email_to_verify_on_post was set)
                flash("Invalid OTP. Please try again.", "error") # Removed "or user not found" for simplicity
                return render_template('verify.html', email=email_to_verify_on_post)
                
    return render_template('verify.html', email=email_for_template)


@app.route('/logout')
def logout():
    session.clear()
    flash("You have been logged out.", "info")
    return redirect(url_for('welcome'))

# --- Video Conferencing Routes (Integrated) ---
@app.route('/video_chat_landing_page')
# @login_required # Uncomment this if video chat should only be for logged-in, verified users
def video_chat_landing_page():
    # IMPORTANT: This page (video_chat.html) must contain client-side JavaScript
    # that connects to the SocketIO server using the '/video' namespace.
    # Example: const socket = io('/video');
    return render_template('video_chat.html')

@socketio.on('connect', namespace='/video')
def video_handle_connect():
    print(f"Video client connected: {request.sid} to /video namespace")

@socketio.on('disconnect', namespace='/video')
def video_handle_disconnect():
    print(f"Video client disconnected: {request.sid} from /video namespace")
    for room_id, occupants in list(video_rooms.items()):
        if request.sid in occupants:
            occupants.remove(request.sid)
            # leave_room is context-aware of namespace if called inside namespaced handler
            # but explicit sid and namespace is good for clarity.
            leave_room(room_id, sid=request.sid, namespace='/video')
            print(f"User {request.sid} left video room {room_id}")
            
            # Emit to the specific room in the specific namespace
            socketio.to(room_id, namespace='/video').emit('user-left', {'sid': request.sid})
            
            if not occupants:
                del video_rooms[room_id]
                print(f"Video room {room_id} is empty and removed.")
            break

@socketio.on('join', namespace='/video')
def video_on_join(data):
    room_id = data.get('room')
    if not room_id:
        # Emit error back to the sender (request.sid) in their current namespace
        emit('error', {'message': 'Room ID is required'})
        return

    # Join the SocketIO room structure (specific to namespace)
    join_room(room_id, sid=request.sid, namespace='/video')
    
    if room_id not in video_rooms:
        video_rooms[room_id] = []
    
    # Tell the new user about existing users in our custom tracking
    # Important: This list is from *before* adding the current user to video_rooms[room_id]
    other_users_in_room = [sid for sid in video_rooms[room_id] if sid != request.sid]
    if other_users_in_room:
        # Emit only to the sender (request.sid)
        emit('other-users', {'users': other_users_in_room})

    # Add user to our custom room tracking if not already present
    if request.sid not in video_rooms[room_id]:
        video_rooms[room_id].append(request.sid)
    
    # Notify OTHERS in the SocketIO room about the new user.
    # .except_self() correctly omits request.sid from the broadcast within this handler's context.
    socketio.to(room_id, namespace='/video').except_self().emit('user-joined', {'sid': request.sid})
    
    print(f"User {request.sid} joined video room {room_id}. Occupants: {video_rooms[room_id]}")
    
    # Confirm to the joining user that they've joined
    emit('joined-room', {'room_id': room_id, 'sid': request.sid})


@socketio.on('signal', namespace='/video')
def video_on_signal(data):
    target_sid = data.get('target_sid')
    if not target_sid:
        print("Video signal: Error: Missing target_sid")
        # Optionally, emit an error back to sender:
        # emit('error', {'message': 'Signal target_sid is required'})
        return

    message_to_send = {
        'sender_sid': request.sid,
        'type': data.get('type'),
        'payload': data.get('payload')
    }
    # Send directly to the target SID's private room, in the correct namespace
    socketio.emit('signal', message_to_send, room=target_sid, namespace='/video')
    # print(f"Relaying signal from {request.sid} to {target_sid} in /video: Type {data.get('type')}")


@socketio.on('subtitle-text', namespace='/video')
def video_handle_subtitle_text(data):
    room_id = data.get('room')
    text = data.get('text')
    # Use sender_sid from data if provided (e.g., for relayed subtitles), else default to current emitter
    sender_sid = data.get('sender_sid', request.sid) 

    if room_id and text:
        # print(f"Subtitle in room {room_id} from {sender_sid} (via {request.sid}): {text}")
        # Broadcast to everyone in the room *except* the original sender (request.sid)
        socketio.to(room_id, namespace='/video').except_self().emit('new-subtitle', {
            'text': text,
            'sender_sid': sender_sid # This ensures the displayed sender is correct
        })

# --- Main Execution ---
if __name__ == '__main__':
    init_db()
    print("Starting Flask-SocketIO server on http://localhost:5000")
    # Ensure you have eventlet or gevent installed for production,
    # e.g., pip install eventlet
    # For development, the Werkzeug development server (default) is usually fine.
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)