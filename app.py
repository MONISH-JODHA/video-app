from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_very_secret_key!' # Change this in production
socketio = SocketIO(app, cors_allowed_origins="*") # Allow all origins for simplicity

# Store room information (very basic, in-memory)
# In a real app, you'd use a database
rooms = {}

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")
    # Clean up rooms if user disconnects
    for room_id, occupants in list(rooms.items()):
        if request.sid in occupants:
            occupants.remove(request.sid)
            leave_room(room_id)
            print(f"User {request.sid} left room {room_id}")
            # Notify other users in the room that this user left
            socketio.to(room_id).emit('user-left', {'sid': request.sid})
            if not occupants:
                del rooms[room_id]
                print(f"Room {room_id} is now empty and removed.")
            break

@socketio.on('join')
def on_join(data):
    room_id = data.get('room')
    if not room_id:
        emit('error', {'message': 'Room ID is required'})
        return

    join_room(room_id)
    if room_id not in rooms:
        rooms[room_id] = []
    
    # Notify existing users in the room about the new user
    # But don't notify the new user about themselves
    other_users_in_room = [sid for sid in rooms[room_id] if sid != request.sid]
    if other_users_in_room:
        emit('other-users', {'users': other_users_in_room}) # Send to the new user

    # Add user to room and notify others
    if request.sid not in rooms[room_id]:
        rooms[room_id].append(request.sid)
        socketio.to(room_id).except_self().emit('user-joined', {'sid': request.sid})
        print(f"User {request.sid} joined room {room_id}. Occupants: {rooms[room_id]}")
    
    emit('joined-room', {'room_id': room_id, 'sid': request.sid})


@socketio.on('signal')
def on_signal(data):
    """
    Relay signaling messages (offer, answer, candidate) to the target peer.
    'data' should contain:
    - target_sid: The recipient's socket ID
    - type: 'offer', 'answer', or 'candidate'
    - payload: The SDP (Session Description Protocol) or ICE candidate
    """
    target_sid = data.get('target_sid')
    if not target_sid:
        print("Error: Signal message missing target_sid")
        return

    # Add sender's SID to the message so the recipient knows who it's from
    message_to_send = {
        'sender_sid': request.sid,
        'type': data.get('type'),
        'payload': data.get('payload')
    }
    print(f"Relaying signal from {request.sid} to {target_sid}: Type {data.get('type')}")
    socketio.emit('signal', message_to_send, room=target_sid) # Send directly to the target SID


# ... (existing Flask and SocketIO setup) ...

@socketio.on('subtitle-text')
def handle_subtitle_text(data):
    room_id = data.get('room')
    text = data.get('text')
    sender_sid = data.get('sender_sid', request.sid) # Get sender_sid from data, fallback to request.sid

    if room_id and text:
        print(f"Subtitle in room {room_id} from {sender_sid}: {text}")
        # Broadcast to everyone in the room *except* the sender
        socketio.to(room_id).except_self().emit('new-subtitle', {
            'text': text,
            'sender_sid': sender_sid
        })

if __name__ == '__main__':
    print("Starting Flask-SocketIO server on http://localhost:5000")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)