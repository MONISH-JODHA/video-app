document.addEventListener('DOMContentLoaded', () => {
    // This assumes videoSocket is defined globally in video_chat.html before this script runs
    // e.g., <script> const videoSocket = io(window.location.origin + '/video'); </script>
    // If not, define it here:
    // const socket = io(window.location.origin + '/video');
    const socket = typeof videoSocket !== 'undefined' ? videoSocket : io(window.location.origin + '/video');


    const localVideo = document.getElementById('local-video');
    const videosContainer = document.getElementById('videos-container');
    const createRoomBtn = document.getElementById('create-room-btn');
    const roomIdInput = document.getElementById('room-id-input');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');
    const roomInfoDiv = document.getElementById('room-info-display'); // Corrected ID from your HTML
    const displayRoomId = document.getElementById('display-room-id');
    const messagesLog = document.getElementById('messages-log'); // Corrected ID

    let localStream;
    let currentRoomId = null;
    let mySid = null;
    const peerConnections = {};

    let speechRecognition;
    let isRecognizing = false;
    let ccButton;
    let subtitlesDisplay; // For local subtitles
    let speechRecognitionRetries = 0;
    const MAX_SPEECH_RETRIES = 2;

    const iceConfiguration = {
        iceServers: [ { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' } ]
    };

    function logMessage(message) {
        console.log(message);
        if (messagesLog) { // Check if messagesLog element exists
            const p = document.createElement('p');
            p.textContent = message;
            messagesLog.appendChild(p);
            messagesLog.scrollTop = messagesLog.scrollHeight;
        } else {
            console.warn("messagesLog element not found. Cannot log to UI:", message);
        }
    }

    function generateRoomId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    function setupSubtitles() {
        if (document.getElementById('cc-toggle-btn')) return; // Already set up

        ccButton = document.createElement('button');
        subtitlesDisplay = document.createElement('div'); // For local spoken words

        ccButton.id = 'cc-toggle-btn';
        ccButton.textContent = 'CC (Off)';
        ccButton.disabled = true; // Will be enabled later
        const controlsDiv = document.getElementById('video-controls'); // Corrected ID from your HTML
        if (controlsDiv) {
            // Insert CC button before the leave button, or at the end if leave doesn't exist
            const leaveBtnRef = document.getElementById('leave-room-btn');
            if (leaveBtnRef) {
                controlsDiv.insertBefore(ccButton, leaveBtnRef);
            } else {
                controlsDiv.appendChild(ccButton);
            }
        } else {
            console.error("Error: 'video-controls' div not found for CC button.");
            return; // Cannot proceed without controls div
        }

        // Local subtitles display
        subtitlesDisplay.id = 'subtitles-output'; // Used by onresult
        // Style it similarly to remote-subtitles-area or messages-log
        subtitlesDisplay.style.width = '80%';
        subtitlesDisplay.style.maxWidth = '700px';
        subtitlesDisplay.style.backgroundColor = 'rgba(0,0,0,0.4)';
        subtitlesDisplay.style.color = '#ecf0f1';
        subtitlesDisplay.style.padding = '10px';
        subtitlesDisplay.style.borderRadius = '5px';
        subtitlesDisplay.style.marginTop = '15px';
        subtitlesDisplay.style.minHeight = '40px';
        subtitlesDisplay.style.border = '1px solid #34495e';
        // Insert local subtitles display area after room-info, before videos
        const roomInfoDisplayEl = document.getElementById('room-info-display');
        if (roomInfoDisplayEl && roomInfoDisplayEl.parentNode) {
            roomInfoDisplayEl.parentNode.insertBefore(subtitlesDisplay, videosContainer);
        } else if (controlsDiv && controlsDiv.parentNode) { // Fallback: after controls
             controlsDiv.parentNode.insertBefore(subtitlesDisplay, videosContainer);
        } else {
            document.body.appendChild(subtitlesDisplay); // Absolute fallback
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
            speechRecognitionRetries = 0;
        };

        speechRecognition.onerror = (event) => {
            let errorMessage = 'Speech recognition error: ' + event.error;
            let willRetry = false;

            if (event.error === 'network') {
                errorMessage += ". Please check your internet connection and firewall settings. The subtitle service might be temporarily unavailable.";
                if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
                    errorMessage += " If using Brave, check Shields settings for this site.";
                }
                if (speechRecognitionRetries < MAX_SPEECH_RETRIES && currentRoomId && ccButton && ccButton.textContent === 'CC (On)') {
                    willRetry = true;
                    speechRecognitionRetries++;
                    logMessage(`Attempting to restart speech recognition (attempt ${speechRecognitionRetries}/${MAX_SPEECH_RETRIES})...`);
                    isRecognizing = true; 
                    if(ccButton) ccButton.textContent = 'CC (On)';
                    setTimeout(() => {
                        if (currentRoomId && ccButton && ccButton.textContent === 'CC (On)') {
                            try { speechRecognition.start(); }
                            catch(e) {
                                console.error("Error restarting speech recognition:", e);
                                logMessage("Could not restart CC after retry attempt.");
                                isRecognizing = false; if(ccButton) ccButton.textContent = 'CC (Off)';
                            }
                        } else {
                            logMessage("Speech recognition retry cancelled (user action, room left, or state changed).");
                            if (isRecognizing) isRecognizing = false;
                            if (ccButton && ccButton.textContent === 'CC (On)') ccButton.textContent = 'CC (Off)';
                        }
                    }, 3000 * speechRecognitionRetries);
                } else if (speechRecognitionRetries >= MAX_SPEECH_RETRIES) {
                    logMessage("Max retries for speech recognition reached for network error.");
                }
            } else if (event.error === 'no-speech') {
                errorMessage += ". No speech detected. Try speaking louder.";
            } else if (event.error === 'audio-capture') {
                errorMessage += ". Microphone problem.";
            } else if (event.error === 'not-allowed') {
                errorMessage += ". Microphone permission denied for subtitles.";
                if (typeof InstallTrigger !== 'undefined') {
                    errorMessage += " In Firefox, ensure microphone permissions are always allowed and check about:config for media.webspeech.recognition.enable if issues persist.";
                }
            } else if (event.error === 'aborted') {
                errorMessage += ". Recognition aborted.";
            }
            logMessage(errorMessage);
            console.error('Speech recognition error object:', event);
            if (!willRetry) {
                isRecognizing = false; if(ccButton) ccButton.textContent = 'CC (Off)';
            }
        };

        speechRecognition.onend = () => {
            if (isRecognizing && ccButton && ccButton.textContent === 'CC (On)') {
                logMessage('Speech recognition segment processing concluded (retry may be pending or browser ended session).');
            } else {
                logMessage('Speech recognition session processing ended.');
            }
        };

        speechRecognition.onresult = (event) => {
            let interimTranscript = ''; let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
                else interimTranscript += event.results[i][0].transcript;
            }
            if(subtitlesDisplay) subtitlesDisplay.textContent = finalTranscript + interimTranscript; // Update local display
            if (finalTranscript.trim() && currentRoomId && mySid) {
                socket.emit('subtitle-text', { text: finalTranscript, sender_sid: mySid, room: currentRoomId });
            }
        };

        ccButton.addEventListener('click', () => {
            if (isRecognizing) {
                speechRecognition.stop(); isRecognizing = false; ccButton.textContent = 'CC (Off)';
                speechRecognitionRetries = 0; logMessage("Speech recognition manually stopped.");
            } else {
                if (localStream && localStream.getAudioTracks().length > 0) {
                    try {
                        speechRecognitionRetries = 0; speechRecognition.start();
                    } catch (e) {
                        logMessage("Could not start speech recognition: " + e.message);
                        isRecognizing = false; ccButton.textContent = 'CC (Off)';
                    }
                } else {
                    alert('Cannot start CC: No local audio stream or permissions denied.');
                }
            }
        });
        // Button enabled state is managed by updateUIAfterJoin and when stream starts
        ccButton.disabled = true;
    }


    async function startLocalStream() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            logMessage('Local stream started.');
            if (createRoomBtn) createRoomBtn.disabled = false;
            if (joinRoomBtn) joinRoomBtn.disabled = false;

            // Setup CC button if not already present
            if (!document.getElementById('cc-toggle-btn')) {
                setupSubtitles();
            }
            // Enable CC button only if API is supported AND user is in a room (or about to join)
            // If currentRoomId is null, it means user hasn't joined a room yet.
            // The button will be fully enabled in updateUIAfterJoin or joined-room.
            if (ccButton && !ccButton.textContent.includes('Unsupported')) {
                 ccButton.disabled = !currentRoomId; // Only enable if already in a room and stream is up
            }

        } catch (error) {
            console.error('Error accessing media devices.', error);
            logMessage('Error accessing media devices: ' + error.message);
            alert('Could not access camera and microphone. Please check permissions.');
            if(createRoomBtn) createRoomBtn.disabled = true;
            if(joinRoomBtn) joinRoomBtn.disabled = true;
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
            await startLocalStream(); // This will also attempt to setup/enable CC button
            if (!localStream) return;
        }
        currentRoomId = roomId;
        socket.emit('join', { room: currentRoomId });
        logMessage(`Attempting to join room: ${currentRoomId}`);
        // updateUIAfterJoin will be called via 'joined-room' or implicitly by UI changes
    }

    if(createRoomBtn) {
        createRoomBtn.addEventListener('click', async () => {
            const newRoomId = generateRoomId();
            if(roomIdInput) roomIdInput.value = newRoomId;
            await performJoinRoom(newRoomId);
        });
    }

    if(joinRoomBtn) {
        joinRoomBtn.addEventListener('click', async () => {
            const roomIdToJoin = roomIdInput ? roomIdInput.value.trim() : '';
            if (!roomIdToJoin) {
                alert('Please enter a Room ID to join.');
                return;
            }
            await performJoinRoom(roomIdToJoin);
        });
    }

    if(leaveRoomBtn) {
        leaveRoomBtn.addEventListener('click', () => {
            if (currentRoomId) {
                socket.disconnect(); // Server handles room cleanup on disconnect
            }
        });
    }


    function updateUIAfterJoin(roomId) {
        if(displayRoomId) displayRoomId.textContent = roomId;
        if(roomInfoDiv) roomInfoDiv.style.display = 'block';
        if(createRoomBtn) createRoomBtn.style.display = 'none';
        if(joinRoomBtn) joinRoomBtn.style.display = 'none';
        if(roomIdInput) roomIdInput.style.display = 'none';
        if(leaveRoomBtn) leaveRoomBtn.style.display = 'inline-block';

        if(ccButton && !ccButton.textContent.includes('Unsupported')) {
            ccButton.disabled = !(localStream && localStream.getAudioTracks().length > 0);
        }
    }

    function resetUIAndState() {
        currentRoomId = null;
        // mySid will be updated by socket.io on connect

        for (const sid in peerConnections) {
            if (peerConnections[sid]) peerConnections[sid].close();
            const remoteVideoWrapper = document.getElementById(`video-wrapper-${sid}`);
            if (remoteVideoWrapper) remoteVideoWrapper.remove();
        }
        Object.keys(peerConnections).forEach(key => delete peerConnections[key]);

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            if(localVideo) localVideo.srcObject = null;
        }

        if (speechRecognition && isRecognizing) {
            speechRecognition.stop();
        }
        isRecognizing = false; speechRecognitionRetries = 0;
        if (ccButton) {
             ccButton.textContent = 'CC (Off)'; ccButton.disabled = true;
        }

        if(roomInfoDiv) roomInfoDiv.style.display = 'none';
        if(displayRoomId) displayRoomId.textContent = '';
        if(createRoomBtn) createRoomBtn.style.display = 'inline-block';
        if(joinRoomBtn) joinRoomBtn.style.display = 'inline-block';
        if(roomIdInput) roomIdInput.style.display = 'inline-block';
        if(roomIdInput) roomIdInput.value = '';
        if(leaveRoomBtn) leaveRoomBtn.style.display = 'none';

        if(messagesLog) messagesLog.innerHTML = '';
        if(subtitlesDisplay) subtitlesDisplay.textContent = '';
        const remoteSubtitlesDiv = document.getElementById('remote-subtitles-area');
        if (remoteSubtitlesDiv) remoteSubtitlesDiv.innerHTML = '';

        if(createRoomBtn) createRoomBtn.disabled = true; // Disabled until stream is ready
        if(joinRoomBtn) joinRoomBtn.disabled = true; // Disabled until stream is ready

        if (!socket.connected) {
            socket.connect(); // Attempt to reconnect
        } else {
             startLocalStream(); // If still connected, just re-init local parts
        }
    }

    socket.on('connect', () => {
        mySid = socket.id;
        console.log('Connected to server with SID:', mySid);
        logMessage('Connected to signaling server.');
        if(createRoomBtn) createRoomBtn.disabled = true;
        if(joinRoomBtn) joinRoomBtn.disabled = true;

        // Ensure setupSubtitles is called if the button isn't there yet.
        // This is important if the page was reloaded or user navigated back.
        if (!document.getElementById('cc-toggle-btn') && document.getElementById('video-controls')) {
            setupSubtitles();
        }

        if (ccButton && !ccButton.textContent.includes('Unsupported')) {
             ccButton.disabled = true; // Will be enabled once in a room and stream is active
        }
        startLocalStream(); // This will try to get media and then enable buttons
    });

    socket.on('disconnect', () => {
        logMessage('Disconnected from signaling server.');
        // Reset UI if was in an active call state
        if (currentRoomId || Object.keys(peerConnections).length > 0 || localStream) {
            resetUIAndState();
        }
    });

    socket.on('joined-room', (data) => {
        logMessage(`Successfully joined room: ${data.room_id}. Your SID: ${data.sid}`);
        mySid = data.sid; // Update our own SID from server confirmation
        currentRoomId = data.room_id; // Ensure currentRoomId is set
        updateUIAfterJoin(data.room_id); // Update UI based on successful join
    });

    socket.on('other-users', (data) => {
        logMessage(`Other users in room: ${data.users.join(', ')}`);
        data.users.forEach(sid => {
            if (sid !== mySid) createPeerConnection(sid, true); // I am initiator to existing users
        });
    });

    socket.on('user-joined', (data) => {
        const remoteSid = data.sid;
        if (remoteSid === mySid) return;
        logMessage(`User ${remoteSid} joined the room.`);
        // New user will see me in their 'other-users' and initiate connection.
        // No action needed from my side here unless I want to force initiation.
    });

    socket.on('user-left', (data) => {
        const remoteSid = data.sid;
        logMessage(`User ${remoteSid} left the room.`);
        if (peerConnections[remoteSid]) {
            peerConnections[remoteSid].close(); delete peerConnections[remoteSid];
        }
        const remoteVideoWrapper = document.getElementById(`video-wrapper-${remoteSid}`);
        if (remoteVideoWrapper) remoteVideoWrapper.remove();
    });

    socket.on('signal', async (data) => {
        const { sender_sid, type, payload } = data;
        if (sender_sid === mySid) return;
        let pc = peerConnections[sender_sid];

        if (type === 'offer') {
            if (!pc) pc = createPeerConnection(sender_sid, false); // Not initiator
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(payload));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('signal', { target_sid: sender_sid, type: 'answer', payload: answer });
                logMessage(`Sent answer to ${sender_sid}`);
            } catch (error) { console.error(`Error handling offer from ${sender_sid}:`, error); }
        } else if (type === 'answer') {
            if (pc) {
                try { await pc.setRemoteDescription(new RTCSessionDescription(payload)); logMessage(`Processed answer from ${sender_sid}`); }
                catch (error) { console.error(`Error handling answer from ${sender_sid}:`, error); }
            }
        } else if (type === 'candidate') {
            if (pc) {
                try {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(new RTCIceCandidate(payload));
                    } else {
                        if (!pc.pendingCandidates) pc.pendingCandidates = [];
                        pc.pendingCandidates.push(payload); logMessage(`Buffered ICE candidate from ${sender_sid}`);
                    }
                } catch (error) {
                    if (!(error.name === 'InvalidStateError' && error.message.includes("candidate cannot be added before remoteDescription"))) {
                         console.error(`Error adding ICE candidate from ${sender_sid}:`, error);
                    } else if (!pc.pendingCandidates || !pc.pendingCandidates.includes(payload)) {
                         logMessage(`INFO: ICE candidate from ${sender_sid} arrived before remote description. Buffering.`);
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
                        pc.pendingCandidates.unshift(candidate); break;
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
        subtitleEntry.style.fontStyle = 'italic'; subtitleEntry.style.color = '#ecf0f1'; // Light text for dark bg
        subtitleEntry.style.margin = '2px 0'; subtitleEntry.textContent = `[${sender_sid.substring(0, 6)}]: ${text}`;
        let remoteSubtitlesDiv = document.getElementById('remote-subtitles-area');
        if (!remoteSubtitlesDiv) {
            remoteSubtitlesDiv = document.createElement('div'); remoteSubtitlesDiv.id = 'remote-subtitles-area';
            remoteSubtitlesDiv.style.width = '80%'; remoteSubtitlesDiv.style.maxWidth = '700px';
            remoteSubtitlesDiv.style.backgroundColor = 'rgba(0,0,0,0.4)'; remoteSubtitlesDiv.style.color = '#ecf0f1';
            remoteSubtitlesDiv.style.padding = '10px'; remoteSubtitlesDiv.style.borderRadius = '5px';
            remoteSubtitlesDiv.style.marginTop = '15px'; remoteSubtitlesDiv.style.minHeight = '40px';
            remoteSubtitlesDiv.style.border = '1px solid #34495e'; remoteSubtitlesDiv.style.overflowY = 'auto';

            const videosContainerEl = document.getElementById('videos-container');
            if (videosContainerEl && videosContainerEl.parentNode) { // Insert after videos container
                 videosContainerEl.parentNode.insertBefore(remoteSubtitlesDiv, videosContainerEl.nextSibling);
            } else { document.body.appendChild(remoteSubtitlesDiv); } // Fallback
        }
        remoteSubtitlesDiv.appendChild(subtitleEntry);
        remoteSubtitlesDiv.scrollTop = remoteSubtitlesDiv.scrollHeight;
    });

    socket.on('error', (data) => { // Server-sent errors (e.g., from video_on_join)
        logMessage(`Server Error: ${data.message}`);
        alert(`Server Error: ${data.message}`);
    });

    function createPeerConnection(remoteSid, isInitiator) {
        if (peerConnections[remoteSid]) return peerConnections[remoteSid];
        logMessage(`Creating PeerConnection to ${remoteSid}. Initiator: ${isInitiator}`);
        const pc = new RTCPeerConnection(iceConfiguration);
        peerConnections[remoteSid] = pc; pc.pendingCandidates = [];
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
                remoteVideoWrapper = document.createElement('div'); remoteVideoWrapper.id = `video-wrapper-${remoteSid}`;
                remoteVideoWrapper.className = 'video-wrapper';
                remoteVideo = document.createElement('video'); remoteVideo.id = `video-${remoteSid}`;
                remoteVideo.autoplay = true; remoteVideo.playsInline = true;
                const nameTag = document.createElement('p'); nameTag.textContent = `Remote (${remoteSid.substring(0, 6)}...)`;
                remoteVideoWrapper.appendChild(remoteVideo); remoteVideoWrapper.appendChild(nameTag);
                if(videosContainer) videosContainer.appendChild(remoteVideoWrapper);
            }
            if (event.streams && event.streams[0]) remoteVideo.srcObject = event.streams[0];
            else remoteVideo.srcObject = new MediaStream([event.track]);
        };
        pc.oniceconnectionstatechange = () => {
            logMessage(`ICE connection state for ${remoteSid}: ${pc.iceConnectionState}`);
            if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
                logMessage(`Connection to ${remoteSid} ${pc.iceConnectionState}. Cleaning up.`);
                if (peerConnections[remoteSid]) {
                    peerConnections[remoteSid].close(); delete peerConnections[remoteSid];
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
                logMessage("Error: Cannot create offer, local stream missing."); return pc;
            }
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => socket.emit('signal', { target_sid: remoteSid, type: 'offer', payload: pc.localDescription }))
                .then(() => logMessage(`Sent offer to ${remoteSid}`))
                .catch(error => console.error(`Error creating offer for ${remoteSid}:`, error));
        }
        return pc;
    }

    // Initial button states - disabled until stream is ready
    if(createRoomBtn) createRoomBtn.disabled = true;
    if(joinRoomBtn) joinRoomBtn.disabled = true;
    // CC button is handled by setupSubtitles and subsequent logic
});