import flask
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
from flask_socketio import SocketIO, emit, join_room, leave_room # emit is already imported

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'a_very_secure_default_secret_key_123!PleaseChange')
CORS(app, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*")

APP_EMAIL_SENDER = os.getenv('EMAIL_USER')
APP_EMAIL_PASSWORD = os.getenv('PASSWORD')
DB_PATH = './users.db'

video_rooms = {}


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
                session.pop('username', None)
                flash("Account not verified. Please verify or log in again.", "danger")
                return redirect(url_for('welcome'))
        return f(*args, **kwargs)
    return decorated_function

@app.route('/', methods=['GET'])
def welcome():
    if 'username' in session:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT verified FROM users WHERE username = ?", (session['username'],)).fetchone()
            if user and user['verified']:
                return redirect(url_for('video_chat_landing_page'))
            else:
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
            session['login_email'] = email
            return redirect(url_for('enter_password'))
        else:
            otp = str(random.randint(100000, 999999))
            with sqlite3.connect(DB_PATH) as conn_update:
                 conn_update.execute("UPDATE users SET otp = ? WHERE username = ?", (otp, email))
                 conn_update.commit()
            if send_otp_email(email, otp): flash("Account not verified. A new OTP has been sent.", "info")
            else: flash("Account not verified. Failed to send OTP.", "error")
            session['pending_verification_email'] = email
            return redirect(url_for('verify_otp_page'))
    else:
        session['signup_email'] = email
        return redirect(url_for('create_account'))

@app.route('/enter_password', methods=['GET', 'POST'])
def enter_password():
    email = session.get('login_email')
    if not email: flash("Session expired. Please start over.", "warning"); return redirect(url_for('welcome'))
    if request.method == 'POST':
        password = request.form.get('password', '')
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT * FROM users WHERE username = ? AND password = ?", (email, password)).fetchone() # INSECURE
        if user and user['verified']:
            session['username'] = user['username']; session.pop('login_email', None)
            flash(f"Welcome back, {user['username']}!", "success"); return redirect(url_for('video_chat_landing_page'))
        elif user and not user['verified']:
            flash("Account not verified. Please verify.", "warning"); session['pending_verification_email'] = email
            return redirect(url_for('verify_otp_page'))
        else: flash("Invalid password or account issue.", "error")
    return render_template('enter_password.html', email=email)

@app.route('/create_account', methods=['GET', 'POST'])
def create_account():
    email = session.get('signup_email')
    if not email: flash("Session expired. Please start over.", "warning"); return redirect(url_for('welcome'))
    if request.method == 'POST':
        password = request.form.get('password', ''); confirm_password = request.form.get('confirm_password', '')
        if not password or len(password) < 4: flash("Password must be >= 4 chars.", "error"); return render_template('create_account.html', email=email)
        if password != confirm_password: flash("Passwords do not match.", "error"); return render_template('create_account.html', email=email)
        otp = str(random.randint(100000, 999999))
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO users (username, password, otp, verified) VALUES (?, ?, ?, 0)", (email, password, otp)) # INSECURE
                conn.commit()
            if send_otp_email(email, otp):
                session.pop('signup_email', None); session['pending_verification_email'] = email
                flash("Account created. Check email for OTP.", "success"); return redirect(url_for('verify_otp_page'))
            else: flash("Account created, but failed to send OTP.", "error"); return render_template('create_account.html', email=email)
        except sqlite3.IntegrityError: flash("Email already registered.", "error"); session.pop('signup_email', None); return redirect(url_for('welcome'))
        except Exception as e: print(f"Create account error: {e}"); flash(f"An unexpected error occurred. Please try again.", "error"); return render_template('create_account.html', email=email)
    return render_template('create_account.html', email=email)

@app.route('/verify_otp', methods=['GET', 'POST'])
def verify_otp_page():
    email_for_template = request.form.get('email_for_verification_fallback', session.get('pending_verification_email', ''))
    if request.method == 'GET' and not session.get('pending_verification_email'): flash("No pending verification.", "info"); return redirect(url_for('welcome'))
    if request.method == 'POST':
        otp_input = request.form.get('otp', '').strip()
        email_to_verify = request.form.get('email_for_verification_fallback', session.get('pending_verification_email', ''))
        if not email_to_verify: flash("Could not determine email for OTP. Start over.", "error"); return redirect(url_for('welcome'))
        if not otp_input: flash("OTP required.", "error"); return render_template('verify.html', email=email_to_verify)
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            user = conn.execute("SELECT * FROM users WHERE username = ?", (email_to_verify,)).fetchone()
            if user and not user['verified'] and user['otp'] == otp_input:
                conn.execute("UPDATE users SET verified = 1, otp = NULL WHERE username = ?", (email_to_verify,)); conn.commit()
                session.pop('pending_verification_email', None); flash("Email verified! Please log in.", "success"); return redirect(url_for('welcome'))
            elif user and user['verified']: session.pop('pending_verification_email', None); flash("Account already verified. Log in.", "info"); return redirect(url_for('welcome'))
            else: flash("Invalid OTP.", "error"); return render_template('verify.html', email=email_to_verify)
    return render_template('verify.html', email=email_for_template)

@app.route('/logout')
def logout(): session.clear(); flash("Logged out.", "info"); return redirect(url_for('welcome'))

@app.route('/video_chat_landing_page')
def video_chat_landing_page(): return render_template('video_chat.html')


@socketio.on('connect', namespace='/video')
def video_handle_connect():
    print(f"Video client connected: {request.sid}")

@socketio.on('disconnect', namespace='/video')
def video_handle_disconnect():
    user_sid_leaving = request.sid
    room_left = None
    user_name_leaving = "Unknown"
    print(f"Video client disconnecting: {user_sid_leaving}")
    for room_id, occupants in list(video_rooms.items()):
        if user_sid_leaving in occupants:
            user_name_leaving = occupants.pop(user_sid_leaving)
            room_left = room_id
            leave_room(room_id, sid=user_sid_leaving, namespace='/video')
            print(f"User {user_name_leaving} ({user_sid_leaving}) left video room {room_id}")
            # CORRECTED EMIT:
            socketio.emit('user-left', {'sid': user_sid_leaving, 'name': user_name_leaving}, room=room_id, namespace='/video')
            if not occupants:
                del video_rooms[room_id]
                print(f"Video room {room_id} is empty and removed.")
            break
    if not room_left:
        print(f"User {user_sid_leaving} disconnected but was not found in any active room.")

@socketio.on('join', namespace='/video')
def video_on_join(data):
    room_id = data.get('room')
    user_name = data.get('name', f"Guest_{request.sid[:4]}")
    if not room_id:
        emit('error', {'message': 'Room ID is required'}) # This emit is fine as it's direct to sender
        return
    join_room(room_id, sid=request.sid, namespace='/video')
    if room_id not in video_rooms:
        video_rooms[room_id] = {}
    other_users_info = []
    if video_rooms[room_id]:
        for sid, name_in_room in video_rooms[room_id].items():
            if sid != request.sid:
                other_users_info.append({'sid': sid, 'name': name_in_room})
    if other_users_info:
        emit('other-users', {'users': other_users_info}) # This emit is fine (to sender)
    video_rooms[room_id][request.sid] = user_name
    
    # CORRECTED EMIT:
    socketio.emit('user-joined', {
        'sid': request.sid,
        'name': user_name
    }, room=room_id, namespace='/video', skip_sid=request.sid) # Use skip_sid to exclude sender
    
    print(f"User {user_name} ({request.sid}) joined room {room_id}. Occupants: {len(video_rooms[room_id])}")
    emit('joined-room', {'room_id': room_id, 'sid': request.sid}) # This emit is fine (to sender)

@socketio.on('signal', namespace='/video')
def video_on_signal(data):
    target_sid = data.get('target_sid')
    if not target_sid:
        print("Signal error: Missing target_sid")
        return
    sender_name = "Unknown"
    for room_occupants in video_rooms.values():
        if request.sid in room_occupants:
            sender_name = room_occupants[request.sid]
            break
    message_to_send = {
        'sender_sid': request.sid,
        'sender_name': sender_name,
        'type': data.get('type'),
        'payload': data.get('payload')
    }
    # This emit is to a specific SID (target_sid acts as the room here)
    socketio.emit('signal', message_to_send, room=target_sid, namespace='/video')

@socketio.on('subtitle-text', namespace='/video')
def video_handle_subtitle_text(data):
    room_id = data.get('room')
    text = data.get('text')
    sender_sid = request.sid
    user_name = "Unknown"
    if room_id in video_rooms and sender_sid in video_rooms[room_id]:
        user_name = video_rooms[room_id][sender_sid]
    else:
        user_name = data.get('name', f"User_{sender_sid[:4]}")
    if room_id and text:
        # CORRECTED EMIT:
        socketio.emit('new-subtitle', {
            'text': text,
            'sender_sid': sender_sid,
            'name': user_name
        }, room=room_id, namespace='/video', skip_sid=sender_sid)

@socketio.on('leave', namespace='/video')
def video_on_leave(data): # This is for an explicit 'leave' event if client sends one
    room_id = data.get('room')
    user_sid_leaving = request.sid
    user_name_leaving = "Unknown"
    if room_id and room_id in video_rooms and user_sid_leaving in video_rooms[room_id]:
        user_name_leaving = video_rooms[room_id].pop(user_sid_leaving)
        leave_room(room_id, sid=user_sid_leaving, namespace='/video')
        print(f"User {user_name_leaving} ({user_sid_leaving}) explicitly left video room {room_id}")
        # CORRECTED EMIT:
        socketio.emit('user-left', {'sid': user_sid_leaving, 'name': user_name_leaving}, room=room_id, namespace='/video') # Notify others
        if not video_rooms[room_id]:
            del video_rooms[room_id]
            print(f"Video room {room_id} is empty and removed after explicit leave.")
        emit('left-room-ack', {'room_id': room_id, 'message': 'You have left the room.'}) # Ack to leaving user (fine as is)
    else:
        print(f"User {user_sid_leaving} tried to explicitly leave room {room_id} but was not found or room invalid.")

if __name__ == '__main__':
    init_db()
    print("Starting Flask-SocketIO server on http://localhost:5000")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)
    
