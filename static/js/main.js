document.addEventListener('DOMContentLoaded', () => {
    const socket = io(window.location.origin); // Connect to Socket.IO server

    const localVideo = document.getElementById('local-video');
    const videosContainer = document.getElementById('videos-container');

    const createRoomBtn = document.getElementById('create-room-btn');
    const roomIdInput = document.getElementById('room-id-input');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');

    const roomInfoDiv = document.getElementById('room-info');
    const displayRoomId = document.getElementById('display-room-id');
    const messagesDiv = document.getElementById('messages');

    let localStream;
    let currentRoomId = null;
    let mySid = null;

    const peerConnections = {};

    // --- Subtitles / CC ---
    let speechRecognition;
    let isRecognizing = false;
    let ccButton;
    let subtitlesDisplay;
    let speechRecognitionRetries = 0;
    const MAX_SPEECH_RETRIES = 2; // Max attempts to restart on network error

    const iceConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    function logMessage(message) {
        console.log(message);
        const p = document.createElement('p');
        p.textContent = message;
        messagesDiv.appendChild(p);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function generateRoomId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    // ***** REVISED setupSubtitles FUNCTION *****
    function setupSubtitles() {
        ccButton = document.createElement('button');
        subtitlesDisplay = document.createElement('div');

        ccButton.id = 'cc-toggle-btn';
        ccButton.textContent = 'CC (Off)';
        ccButton.style.marginLeft = '10px';
        ccButton.disabled = true; // Initially disabled
        const controlsDiv = document.getElementById('controls');
        if (controlsDiv) {
            controlsDiv.appendChild(ccButton);
        } else {
            console.error("Error: 'controls' div not found for CC button.");
            return;
        }

        subtitlesDisplay.id = 'subtitles-output';
        subtitlesDisplay.style.marginTop = '10px';
        subtitlesDisplay.style.padding = '5px';
        subtitlesDisplay.style.border = '1px solid #ccc';
        subtitlesDisplay.style.minHeight = '30px';
        subtitlesDisplay.style.backgroundColor = '#f9f9f9';
        // Ensure controlsDiv exists before inserting after it
        if (controlsDiv && controlsDiv.parentNode) {
             controlsDiv.parentNode.insertBefore(subtitlesDisplay, videosContainer); // Place before videos for visibility
        } else {
            document.body.appendChild(subtitlesDisplay); // Fallback
        }


        if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
            ccButton.disabled = true;
            ccButton.textContent = 'CC (Unsupported)';
            logMessage('Speech Recognition API not supported in this browser.');
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        speechRecognition = new SpeechRecognition();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.lang = 'en-US';

        speechRecognition.onstart = () => {
            isRecognizing = true;
            if(ccButton) ccButton.textContent = 'CC (On)';
            logMessage('Speech recognition started.');
            speechRecognitionRetries = 0; // Reset retries on successful start
        };

        speechRecognition.onerror = (event) => {
            let errorMessage = 'Speech recognition error: ' + event.error;
            let willRetry = false;

            if (event.error === 'network') {
                errorMessage += ". Please check your internet connection and firewall settings. The subtitle service might be temporarily unavailable.";
                // Only retry if user intends for CC to be on and is in a room
                if (speechRecognitionRetries < MAX_SPEECH_RETRIES && currentRoomId && ccButton && ccButton.textContent === 'CC (On)') {
                    willRetry = true;
                    speechRecognitionRetries++;
                    logMessage(`Attempting to restart speech recognition (attempt ${speechRecognitionRetries}/${MAX_SPEECH_RETRIES})...`);
                    
                    isRecognizing = true; // Maintain state as "trying to be on"
                    if(ccButton) ccButton.textContent = 'CC (On)';

                    setTimeout(() => {
                        // Check again if CC is still desired before actually retrying
                        if (currentRoomId && ccButton && ccButton.textContent === 'CC (On)') {
                            try {
                                speechRecognition.start(); // onstart will confirm state
                            } catch(e) {
                                console.error("Error restarting speech recognition:", e);
                                logMessage("Could not restart CC after retry attempt.");
                                isRecognizing = false; // Failed retry, so now definitely off
                                if(ccButton) ccButton.textContent = 'CC (Off)';
                            }
                        } else {
                            logMessage("Speech recognition retry cancelled (user action, room left, or state changed).");
                            if (isRecognizing) isRecognizing = false; // Ensure state is off
                            if (ccButton && ccButton.textContent === 'CC (On)') ccButton.textContent = 'CC (Off)';
                        }
                    }, 3000 * speechRecognitionRetries); // Exponential backoff, 3s, 6s
                } else if (speechRecognitionRetries >= MAX_SPEECH_RETRIES) {
                    logMessage("Max retries for speech recognition reached. Please try toggling CC manually or check your network.");
                }
                // If not retrying for network error (e.g. max retries, or user turned off CC), willRetry remains false.
            } else if (event.error === 'no-speech') {
                errorMessage += ". No speech was detected. Try speaking louder or closer to the microphone.";
            } else if (event.error === 'audio-capture') {
                errorMessage += ". Microphone problem. Ensure it's working and permissions are granted.";
            } else if (event.error === 'not-allowed') {
                errorMessage += ". Permission to use the microphone for subtitles was denied or has not been granted. Please check browser permissions.";
            } else if (event.error === 'aborted') {
                errorMessage += ". Speech recognition was aborted, possibly due to a quick stop/start or microphone issue.";
            }
            // This initial log message is always shown for any error
            logMessage(errorMessage);
            console.error('Speech recognition error object:', event);

            // If a retry is NOT being attempted for this error, then the session is truly over.
            // Set state to 'off'.
            if (!willRetry) {
                isRecognizing = false;
                if(ccButton) ccButton.textContent = 'CC (Off)';
            }
            // If willRetry is true, isRecognizing and button text are deliberately kept 'On' by the logic above,
            // awaiting the outcome of the setTimeout.
        };

        speechRecognition.onend = () => {
            // If isRecognizing is true here, it means onerror decided to retry and kept the state 'On'.
            // The onend for the failed session should not change this state.
            // The retry logic (or manual stop) will handle the final state.
            if (isRecognizing && ccButton && ccButton.textContent === 'CC (On)') {
                logMessage('Speech recognition segment processing concluded (retry may be pending/active).');
            } else {
                // This means isRecognizing was already false (e.g., manual stop, or an error that didn't trigger a retry)
                logMessage('Speech recognition session processing ended.');
            }
        };

        speechRecognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }
            // Display your own spoken words locally
            subtitlesDisplay.textContent = finalTranscript + interimTranscript;

            // If you want to send final transcripts to others:
            if (finalTranscript.trim() && currentRoomId && mySid) {
                socket.emit('subtitle-text', {
                    text: finalTranscript,
                    sender_sid: mySid,
                    room: currentRoomId
                });
            }
        };

        ccButton.addEventListener('click', () => {
            if (isRecognizing) {
                speechRecognition.stop(); // This will trigger onend.
                isRecognizing = false;    // Set state immediately.
                ccButton.textContent = 'CC (Off)';
                speechRecognitionRetries = 0; // Reset retries on manual stop.
                logMessage("Speech recognition manually stopped.");
            } else {
                if (localStream && localStream.getAudioTracks().length > 0) {
                    try {
                        speechRecognitionRetries = 0; // Reset before a new manual start.
                        speechRecognition.start();    // onstart will set isRecognizing and button text.
                        // isRecognizing and ccButton.textContent set in onstart
                    } catch (e) {
                        logMessage("Could not start speech recognition: " + e.message);
                        isRecognizing = false;        // Ensure state is off on failure.
                        ccButton.textContent = 'CC (Off)';
                    }
                } else {
                    alert('Cannot start CC: No local audio stream available or permissions denied.');
                }
            }
        });
        // Button will be enabled when user joins a room and stream is active
    }
    // ***** END OF REVISED setupSubtitles FUNCTION *****


    async function startLocalStream() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            logMessage('Local stream started.');
            createRoomBtn.disabled = false;
            joinRoomBtn.disabled = false;
            if (!document.getElementById('cc-toggle-btn')) { // Check if button exists
                setupSubtitles(); // Call if CC button hasn't been set up yet
            }
            // Enable CC button only if API is supported AND user is in a room
            if (ccButton && !ccButton.textContent.includes('Unsupported')) {
                 ccButton.disabled = !currentRoomId;
            }
        } catch (error) {
            console.error('Error accessing media devices.', error);
            logMessage('Error accessing media devices: ' + error.message);
            alert('Could not access camera and microphone. Please check permissions.');
            createRoomBtn.disabled = true;
            joinRoomBtn.disabled = true;
            if(ccButton) ccButton.disabled = true;
        }
    }

    async function performJoinRoom(roomId) {
        if (!roomId) {
            alert('Room ID is invalid.');
            return;
        }
        if (!localStream) {
            logMessage('Local stream not ready. Attempting to start...');
            await startLocalStream();
            if (!localStream) return;
        }

        currentRoomId = roomId;
        socket.emit('join', { room: currentRoomId });
        logMessage(`Attempting to join room: ${currentRoomId}`);
        updateUIAfterJoin(currentRoomId);
    }

    createRoomBtn.addEventListener('click', async () => {
        const newRoomId = generateRoomId();
        roomIdInput.value = newRoomId;
        await performJoinRoom(newRoomId);
    });

    joinRoomBtn.addEventListener('click', async () => {
        const roomIdToJoin = roomIdInput.value.trim();
        if (!roomIdToJoin) {
            alert('Please enter a Room ID to join.');
            return;
        }
        await performJoinRoom(roomIdToJoin);
    });

    leaveRoomBtn.addEventListener('click', () => {
        if (currentRoomId) {
            socket.disconnect();
        }
    });

    function updateUIAfterJoin(roomId) {
        displayRoomId.textContent = roomId;
        roomInfoDiv.style.display = 'block';
        createRoomBtn.style.display = 'none';
        joinRoomBtn.style.display = 'none';
        roomIdInput.style.display = 'none';
        leaveRoomBtn.style.display = 'inline-block';
        if(ccButton && !ccButton.textContent.includes('Unsupported')) {
            ccButton.disabled = !(localStream && localStream.getAudioTracks().length > 0);
        }
    }

    function resetUIAndState() {
        currentRoomId = null;

        for (const sid in peerConnections) {
            if (peerConnections[sid]) peerConnections[sid].close();
            const remoteVideoWrapper = document.getElementById(`video-wrapper-${sid}`);
            if (remoteVideoWrapper) remoteVideoWrapper.remove();
        }
        Object.keys(peerConnections).forEach(key => delete peerConnections[key]);

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            localVideo.srcObject = null;
        }

        if (speechRecognition && isRecognizing) {
            speechRecognition.stop();
        }
        isRecognizing = false;
        speechRecognitionRetries = 0;
        if (ccButton) {
             ccButton.textContent = 'CC (Off)';
             ccButton.disabled = true;
        }

        roomInfoDiv.style.display = 'none';
        displayRoomId.textContent = '';
        createRoomBtn.style.display = 'inline-block';
        joinRoomBtn.style.display = 'inline-block';
        roomIdInput.style.display = 'inline-block';
        roomIdInput.value = '';
        leaveRoomBtn.style.display = 'none';

        messagesDiv.innerHTML = '';
        if(subtitlesDisplay) subtitlesDisplay.textContent = '';
        const remoteSubtitlesDiv = document.getElementById('remote-subtitles-area');
        if (remoteSubtitlesDiv) remoteSubtitlesDiv.innerHTML = '';

        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;

        if (!socket.connected) {
            socket.connect();
        } else {
             startLocalStream();
        }
    }

    socket.on('connect', () => {
        mySid = socket.id;
        console.log('Connected to server with SID:', mySid);
        logMessage('Connected to signaling server.');
        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;
        if (!document.getElementById('cc-toggle-btn')) { // Check if button exists
            setupSubtitles();
        }
        if (ccButton && !ccButton.textContent.includes('Unsupported')) {
             ccButton.disabled = true; // Keep disabled until in a room
        }
        startLocalStream();
    });

    socket.on('disconnect', () => {
        logMessage('Disconnected from signaling server.');
        if (currentRoomId || Object.keys(peerConnections).length > 0 || localStream) {
            resetUIAndState();
        }
    });

    socket.on('joined-room', (data) => {
        logMessage(`Successfully joined room: ${data.room_id}. Your SID: ${data.sid}`);
        mySid = data.sid;
        if(ccButton && !ccButton.textContent.includes('Unsupported')) {
            ccButton.disabled = !(localStream && localStream.getAudioTracks().length > 0);
        }
    });

    socket.on('other-users', (data) => {
        logMessage(`Other users in room: ${data.users.join(', ')}`);
        data.users.forEach(sid => {
            if (sid !== mySid) createPeerConnection(sid, true);
        });
    });

    socket.on('user-joined', (data) => {
        const remoteSid = data.sid;
        if (remoteSid === mySid) return;
        logMessage(`User ${remoteSid} joined the room.`);
    });

    socket.on('user-left', (data) => {
        const remoteSid = data.sid;
        logMessage(`User ${remoteSid} left the room.`);
        if (peerConnections[remoteSid]) {
            peerConnections[remoteSid].close();
            delete peerConnections[remoteSid];
        }
        const remoteVideoWrapper = document.getElementById(`video-wrapper-${remoteSid}`);
        if (remoteVideoWrapper) remoteVideoWrapper.remove();
    });

    socket.on('signal', async (data) => {
        const { sender_sid, type, payload } = data;
        if (sender_sid === mySid) return;
        let pc = peerConnections[sender_sid];

        if (type === 'offer') {
            if (!pc) pc = createPeerConnection(sender_sid, false);
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(payload));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('signal', { target_sid: sender_sid, type: 'answer', payload: answer });
                logMessage(`Sent answer to ${sender_sid}`);
            } catch (error) { console.error(`Error handling offer from ${sender_sid}:`, error); }
        } else if (type === 'answer') {
            if (pc) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(payload));
                    logMessage(`Processed answer from ${sender_sid}`);
                } catch (error) { console.error(`Error handling answer from ${sender_sid}:`, error); }
            }
        } else if (type === 'candidate') {
            if (pc) {
                try {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(new RTCIceCandidate(payload));
                    } else {
                        if (!pc.pendingCandidates) pc.pendingCandidates = [];
                        pc.pendingCandidates.push(payload);
                        logMessage(`Buffered ICE candidate from ${sender_sid}`);
                    }
                } catch (error) {
                    if (!(error.name === 'InvalidStateError' && error.message.includes("candidate cannot be added before remoteDescription"))) {
                         console.error(`Error adding ICE candidate from ${sender_sid}:`, error);
                    } else if (!pc.pendingCandidates || !pc.pendingCandidates.includes(payload)) {
                         logMessage(`INFO: ICE candidate from ${sender_sid} arrived before remote description was fully processed. Buffering.`);
                         if (!pc.pendingCandidates) pc.pendingCandidates = [];
                         if (!pc.pendingCandidates.includes(payload)) pc.pendingCandidates.push(payload);
                    }
                }
            }
        }
    });

    async function processPendingCandidates(pc, remoteSid) {
        if (pc && pc.pendingCandidates && pc.pendingCandidates.length > 0) {
            logMessage(`Processing ${pc.pendingCandidates.length} buffered ICE candidates for ${remoteSid}`);
            while(pc.pendingCandidates.length > 0) {
                const candidate = pc.pendingCandidates.shift();
                try {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } else {
                        logMessage(`Skipping buffered candidate for ${remoteSid}, remoteDescription not yet ready.`);
                        pc.pendingCandidates.unshift(candidate);
                        break;
                    }
                }
                catch (error) { console.error(`Error adding buffered ICE candidate for ${remoteSid}:`, error); }
            }
        }
    }

    socket.on('new-subtitle', (data) => {
        const { text, sender_sid } = data;
        if (sender_sid === mySid) return;
        const subtitleEntry = document.createElement('p');
        subtitleEntry.style.fontStyle = 'italic';
        subtitleEntry.style.color = '#333';
        subtitleEntry.style.margin = '2px 0';
        subtitleEntry.textContent = `[${sender_sid.substring(0, 6)}]: ${text}`;
        let remoteSubtitlesDiv = document.getElementById('remote-subtitles-area');
        if (!remoteSubtitlesDiv) {
            remoteSubtitlesDiv = document.createElement('div');
            remoteSubtitlesDiv.id = 'remote-subtitles-area';
            remoteSubtitlesDiv.style.marginTop = '15px';
            remoteSubtitlesDiv.style.padding = '10px';
            remoteSubtitlesDiv.style.border = '1px dashed #aaa';
            remoteSubtitlesDiv.style.maxHeight = '100px';
            remoteSubtitlesDiv.style.overflowY = 'auto';
            remoteSubtitlesDiv.style.backgroundColor = '#efefef';
            const videosContainerEl = document.getElementById('videos-container');
            if (videosContainerEl && videosContainerEl.parentNode) {
                 videosContainerEl.parentNode.insertBefore(remoteSubtitlesDiv, videosContainerEl.nextSibling);
            } else { document.body.appendChild(remoteSubtitlesDiv); }
        }
        remoteSubtitlesDiv.appendChild(subtitleEntry);
        remoteSubtitlesDiv.scrollTop = remoteSubtitlesDiv.scrollHeight;
    });

    socket.on('error', (data) => {
        logMessage(`Server Error: ${data.message}`);
        alert(`Server Error: ${data.message}`);
    });

    function createPeerConnection(remoteSid, isInitiator) {
        if (peerConnections[remoteSid]) return peerConnections[remoteSid];
        logMessage(`Creating PeerConnection to ${remoteSid}. Initiator: ${isInitiator}`);
        const pc = new RTCPeerConnection(iceConfiguration);
        peerConnections[remoteSid] = pc;
        pc.pendingCandidates = [];

        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        } else { logMessage('Warning: Local stream not available when creating PeerConnection.'); }

        pc.onicecandidate = (event) => {
            if (event.candidate) socket.emit('signal', { target_sid: remoteSid, type: 'candidate', payload: event.candidate });
        };

        pc.ontrack = (event) => {
            logMessage(`Received remote track from ${remoteSid}`);
            let remoteVideoWrapper = document.getElementById(`video-wrapper-${remoteSid}`);
            let remoteVideo = document.getElementById(`video-${remoteSid}`);
            if (!remoteVideoWrapper) {
                remoteVideoWrapper = document.createElement('div');
                remoteVideoWrapper.id = `video-wrapper-${remoteSid}`;
                remoteVideoWrapper.className = 'video-wrapper';
                remoteVideo = document.createElement('video');
                remoteVideo.id = `video-${remoteSid}`;
                remoteVideo.autoplay = true; remoteVideo.playsInline = true;
                const nameTag = document.createElement('p');
                nameTag.textContent = `Remote (${remoteSid.substring(0, 6)}...)`;
                remoteVideoWrapper.appendChild(remoteVideo);
                remoteVideoWrapper.appendChild(nameTag);
                videosContainer.appendChild(remoteVideoWrapper);
            }
            if (event.streams && event.streams[0]) remoteVideo.srcObject = event.streams[0];
            else remoteVideo.srcObject = new MediaStream([event.track]);
        };

        pc.oniceconnectionstatechange = () => {
            logMessage(`ICE connection state for ${remoteSid}: ${pc.iceConnectionState}`);
            if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
                logMessage(`Connection to ${remoteSid} ${pc.iceConnectionState}. Cleaning up.`);
                if (peerConnections[remoteSid]) {
                    peerConnections[remoteSid].close();
                    delete peerConnections[remoteSid];
                }
                const remoteVideoWrapper = document.getElementById(`video-wrapper-${remoteSid}`);
                if (remoteVideoWrapper) remoteVideoWrapper.remove();
            }
        };

        const originalSetRemoteDescription = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = async (description) => {
            try {
                await originalSetRemoteDescription(description);
                await processPendingCandidates(pc, remoteSid);
            } catch (e) { console.error(`Error in setRemoteDescription for ${remoteSid}:`, e); }
        };

        if (isInitiator) {
            if (!localStream) {
                console.error("Cannot create offer: local stream not available.");
                logMessage("Error: Cannot create offer, local stream missing.");
                return pc;
            }
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => socket.emit('signal', { target_sid: remoteSid, type: 'offer', payload: pc.localDescription }))
                .then(() => logMessage(`Sent offer to ${remoteSid}`))
                .catch(error => console.error(`Error creating offer for ${remoteSid}:`, error));
        }
        return pc;
    }

    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
});