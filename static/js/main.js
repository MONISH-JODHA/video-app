document.addEventListener('DOMContentLoaded', () => {
    const socket = typeof videoSocket !== 'undefined' ? videoSocket : io(window.location.origin + '/video');

    const createRoomBtn = document.getElementById('create-room-btn');
    const roomIdInput = document.getElementById('room-id-input');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');
    const roomInfoDiv = document.getElementById('room-info-display');
    const displayRoomId = document.getElementById('display-room-id');
    const messagesLog = document.getElementById('messages-log');
    const videosContainer = document.getElementById('videos-container');

    const localVideo = document.getElementById('local-video');
    const localParticipantNameTag = document.getElementById('local-participant-name');
    const toggleMicButton = document.getElementById('toggle-mic-btn');
    const toggleCameraButton = document.getElementById('toggle-camera-btn');
    const toggleCcButton = document.getElementById('toggle-cc-btn');
    const toggleScreenButton = document.getElementById('toggle-screen-btn');

    const guestNamePromptDiv = document.getElementById('guest-name-prompt');
    const guestNameInput = document.getElementById('guest-name-input');
    const submitGuestNameBtn = document.getElementById('submit-guest-name-btn');

    let localStream, screenStream, originalVideoTrack;
    let currentRoomId = null, mySid = null, localUserName = "Guest";
    const peerConnections = {};

    let speechRecognition, isRecognizing = false, subtitlesDisplay;
    let speechRecognitionRetries = 0; const MAX_SPEECH_RETRIES = 2;
    let isMicOn = true, isCameraOn = true, isCcOn = false, isScreenSharing = false;

    const iceConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

    function logMessage(message) { console.log(message); if (messagesLog) { const p = document.createElement('p'); p.textContent = message; messagesLog.appendChild(p); messagesLog.scrollTop = messagesLog.scrollHeight; } }
    function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
    function setupSubtitlesDisplayArea() { subtitlesDisplay = document.getElementById('subtitles-output'); if (!subtitlesDisplay) console.error("Subtitle display area 'subtitles-output' not found!"); }
    function displayUserSubtitle(text, senderDisplayName, isLocal = false) { if (!subtitlesDisplay) return; const p = document.createElement('p'); p.style.fontWeight = isLocal ? 'bold' : 'normal'; p.innerHTML = `<strong>${senderDisplayName}:</strong> ${text}`; subtitlesDisplay.appendChild(p); subtitlesDisplay.scrollTop = subtitlesDisplay.scrollHeight; setTimeout(() => { if (p.parentNode === subtitlesDisplay) subtitlesDisplay.removeChild(p); }, 20000); }

    function initializeUserName() {
        if (typeof sessionUsername !== 'undefined' && sessionUsername) {
            const emailParts = sessionUsername.split('@');
            localUserName = emailParts[0].charAt(0).toUpperCase() + emailParts[0].slice(1);
            if (localParticipantNameTag) localParticipantNameTag.textContent = `${localUserName} (You)`;
            enableMainControlsAndMedia();
        } else {
            if (guestNamePromptDiv) guestNamePromptDiv.style.display = 'flex'; /* Changed to flex for centering */
            if (guestNameInput) guestNameInput.focus();
            if (createRoomBtn) createRoomBtn.disabled = true;
            if (joinRoomBtn) joinRoomBtn.disabled = true;
        }
    }
    if (submitGuestNameBtn) {
        submitGuestNameBtn.addEventListener('click', () => {
            const name = guestNameInput.value.trim();
            if (name) {
                localUserName = name;
                if (localParticipantNameTag) localParticipantNameTag.textContent = `${localUserName} (You)`;
                if (guestNamePromptDiv) guestNamePromptDiv.style.display = 'none';
                enableMainControlsAndMedia();
            } else { alert("Please enter your name."); }
        });
    }
    function enableMainControlsAndMedia(){
        if(createRoomBtn) createRoomBtn.disabled = false;
        if(joinRoomBtn) joinRoomBtn.disabled = false;
        startLocalMedia();
    }

    function setupSpeechRecognition() {
        if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) { if(toggleCcButton) { toggleCcButton.disabled = true; toggleCcButton.textContent = 'CC N/A'; toggleCcButton.title="CC Not Supported"; } logMessage('Speech Recognition API not supported.'); return; }
        const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
        speechRecognition = new SpeechRecognitionAPI();
        speechRecognition.continuous = true; speechRecognition.interimResults = true; speechRecognition.lang = 'en-US';
        speechRecognition.onstart = () => { isRecognizing = true; logMessage('Speech recognition started.'); speechRecognitionRetries = 0; updateButtonStates(); };
        speechRecognition.onerror = (event) => {
            logMessage('Speech recognition error: ' + event.error); isRecognizing = false;
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { alert("Mic access for CC denied."); isCcOn = false; }
            else if (event.error === 'network' && speechRecognitionRetries < MAX_SPEECH_RETRIES && isCcOn) { speechRecognitionRetries++; logMessage(`SR Network error. Retrying (${speechRecognitionRetries}/${MAX_SPEECH_RETRIES})...`); setTimeout(() => { if (isCcOn && speechRecognition) try { speechRecognition.start(); } catch(e){console.error("SR Retry Error:",e); isCcOn = false; updateButtonStates();} }, 2000 * speechRecognitionRetries); return; }
            else if (event.error !== 'no-speech' && event.error !== 'aborted') isCcOn = false;
            updateButtonStates();
        };
        speechRecognition.onend = () => { const wasRec = isRecognizing; isRecognizing = false; if (isCcOn && speechRecognition && wasRec && !['not-allowed', 'service-not-allowed', 'aborted'].includes(speechRecognition.error) && speechRecognitionRetries < MAX_SPEECH_RETRIES) { try { setTimeout(() => { if (isCcOn) speechRecognition.start(); }, 500); } catch(e){ console.error("SR onend restart error:", e); isCcOn = false; updateButtonStates(); } } else updateButtonStates(); };
        speechRecognition.onresult = (event) => { let finalTranscript = ''; for (let i = event.resultIndex; i < event.results.length; ++i) if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript; if (finalTranscript.trim() && currentRoomId && mySid) { socket.emit('subtitle-text', { text: finalTranscript, sender_sid: mySid, room: currentRoomId, name: localUserName }); displayUserSubtitle(finalTranscript.trim(), localUserName, true); } };
        if (toggleCcButton) { toggleCcButton.disabled = false; toggleCcButton.addEventListener('click', handleToggleCc); }
        updateButtonStates();
    }

    function handleToggleCc() {
        if (!speechRecognition) return; isCcOn = !isCcOn;
        if (isCcOn) { if (localStream && localStream.getAudioTracks().find(t=>t.enabled) && isMicOn) { try { speechRecognitionRetries = 0; speechRecognition.start(); } catch (e) { logMessage("Could not start CC: " + e.message); isCcOn = false; } } else { alert('Cannot start CC: Mic not active or stream unavailable.'); isCcOn = false; } }
        else { if (isRecognizing) speechRecognition.stop(); speechRecognitionRetries = 0; }
        updateButtonStates();
    }

    async function startLocalMedia(isSwitchingToCamera = false) {
        if (!(typeof sessionUsername !== 'undefined' && sessionUsername) && localUserName.toLowerCase() === "guest") { if (guestNamePromptDiv && guestNamePromptDiv.style.display !== 'block' && (!guestNameInput || guestNameInput.value.trim() === '')) { if (guestNamePromptDiv) guestNamePromptDiv.style.display = 'flex'; if (guestNameInput) guestNameInput.focus(); return; } }
        try {
            if (!isSwitchingToCamera && localStream && !isScreenSharing) return;
            const newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            if (localStream) localStream.getTracks().forEach(track => track.stop());
            localStream = newStream; isCameraOn = true; isMicOn = true;
            if (localStream.getVideoTracks().length > 0) originalVideoTrack = localStream.getVideoTracks()[0]; else originalVideoTrack = null;
            if (!isScreenSharing) { localVideo.srcObject = localStream; if (currentRoomId) updateAllPeerConnectionsWithNewTrack(originalVideoTrack, localStream); }
            if (isCcOn && speechRecognition && !isRecognizing) { try { if(isMicOn) speechRecognition.start(); } catch(e){console.error("Error starting SR after media init:",e)} }
            updateButtonStates(); if(createRoomBtn) createRoomBtn.disabled = false; if(joinRoomBtn) joinRoomBtn.disabled = false;
        } catch (error) { console.error('Error accessing media devices.', error); logMessage('Error accessing media: ' + error.message); alert('Could not access camera/mic. Check permissions.'); isCameraOn = false; isMicOn = false; updateButtonStates(); if(createRoomBtn) createRoomBtn.disabled = true; if(joinRoomBtn) joinRoomBtn.disabled = true; }
    }

    function handleToggleCamera() { if (!localStream || isScreenSharing) { if(isScreenSharing) alert("Stop screen sharing to toggle camera."); return; } isCameraOn = !isCameraOn; localStream.getVideoTracks().forEach(track => track.enabled = isCameraOn); updateButtonStates(); }
    function handleToggleMic() { if (!localStream && !screenStream) return; isMicOn = !isMicOn; [localStream, screenStream].filter(s => s).forEach(stream => stream.getAudioTracks().forEach(track => track.enabled = isMicOn)); if (speechRecognition) { if (isMicOn && isCcOn && !isRecognizing) { try { speechRecognition.start(); } catch(e){ if(e.name !== 'InvalidStateError') console.error("Error starting SR:",e)} } else if (!isMicOn && isRecognizing) speechRecognition.stop(); } updateButtonStates(); }

    async function handleToggleScreenShare() {
        if (!isScreenSharing) {
            try {
                const newScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: { echoCancellation: true, noiseSuppression: true } });
                if (localStream && localStream.getVideoTracks().length > 0) originalVideoTrack = localStream.getVideoTracks()[0]; else originalVideoTrack = null;
                if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = false);
                screenStream = newScreenStream; isScreenSharing = true; localVideo.srcObject = screenStream;
                const screenVideoTrack = screenStream.getVideoTracks()[0];
                updateAllPeerConnectionsWithNewTrack(screenVideoTrack, screenStream, 'video');
                if (screenStream.getAudioTracks().length > 0) { screenStream.getAudioTracks().forEach(track => track.enabled = isMicOn); if (isMicOn) updateAllPeerConnectionsWithNewTrack(screenStream.getAudioTracks()[0], screenStream, 'audio'); else if (localStream) updateAllPeerConnectionsWithNewTrack(null, localStream, 'audio'); }
                else if (localStream && localStream.getAudioTracks().length > 0) { localStream.getAudioTracks().forEach(track => track.enabled = isMicOn); if (isMicOn) updateAllPeerConnectionsWithNewTrack(localStream.getAudioTracks()[0], localStream, 'audio'); else updateAllPeerConnectionsWithNewTrack(null, localStream, 'audio'); }
                screenVideoTrack.onended = () => stopScreenShareInternal(true);
            } catch (err) { isScreenSharing = false; logMessage("Could not start screen sharing: " + err.message); if(localStream && originalVideoTrack) localStream.getVideoTracks().forEach(t => t.enabled = isCameraOn); }
        } else stopScreenShareInternal(false);
        updateButtonStates();
    }

    function stopScreenShareInternal(triggeredByTrackEnd = false) {
        if (!isScreenSharing) return; isScreenSharing = false;
        if (screenStream) { screenStream.getTracks().forEach(track => track.stop()); screenStream = null; }
        if (localStream) { localVideo.srcObject = localStream; localStream.getVideoTracks().forEach(t => t.enabled = isCameraOn); if (originalVideoTrack && isCameraOn) updateAllPeerConnectionsWithNewTrack(originalVideoTrack, localStream, 'video'); else updateAllPeerConnectionsWithNewTrack(null, localStream, 'video'); if (localStream.getAudioTracks().length > 0) { localStream.getAudioTracks().forEach(t => t.enabled = isMicOn); if (isMicOn) updateAllPeerConnectionsWithNewTrack(localStream.getAudioTracks()[0], localStream, 'audio'); else updateAllPeerConnectionsWithNewTrack(null, localStream, 'audio'); } }
        else { localVideo.srcObject = null; updateAllPeerConnectionsWithNewTrack(null, null, 'video'); updateAllPeerConnectionsWithNewTrack(null, null, 'audio'); }
        if (!triggeredByTrackEnd) updateButtonStates();
    }

    function updateAllPeerConnectionsWithNewTrack(newTrack, streamForTrack, kind = 'video') { for (const sid in peerConnections) { const pc = peerConnections[sid]; const sender = pc.getSenders().find(s => s.track && s.track.kind === kind); if (sender) sender.replaceTrack(newTrack).catch(e => console.error(`Error replacing ${kind} track for ${sid}:`, e)); else if (newTrack && streamForTrack) try { pc.addTrack(newTrack, streamForTrack); } catch (e) { console.error(`Error adding ${kind} track for ${sid}:`, e); } } }
    function updateButtonStates() { if(toggleCameraButton) { toggleCameraButton.innerHTML = isCameraOn ? '📷' : '🚫📷'; toggleCameraButton.title = isCameraOn ? "Turn Camera Off" : "Turn Camera On"; toggleCameraButton.classList.toggle('toggled-off', !isCameraOn); toggleCameraButton.disabled = isScreenSharing; } if(toggleMicButton) { toggleMicButton.innerHTML = isMicOn ? '🎤' : '🚫🎤'; toggleMicButton.title = isMicOn ? "Turn Mic Off" : "Turn Mic On"; toggleMicButton.classList.toggle('toggled-off', !isMicOn); } if(toggleCcButton) { if (speechRecognition) { toggleCcButton.textContent = 'CC'; toggleCcButton.title = isCcOn ? "Turn CC Off" : "Turn CC On"; toggleCcButton.classList.toggle('toggled-on', isCcOn); toggleCcButton.classList.remove('toggled-off'); toggleCcButton.disabled = !isMicOn || !(localStream && localStream.getAudioTracks().find(t=>t.enabled)) || (isCcOn && !isRecognizing && speechRecognition.error && speechRecognition.error !== 'no-speech'); } else { toggleCcButton.textContent = 'CC'; toggleCcButton.title = "CC Not Supported"; toggleCcButton.disabled = true; } } if(toggleScreenButton) { toggleScreenButton.innerHTML = '💻'; toggleScreenButton.title = isScreenSharing ? "Stop Screen Sharing" : "Share Screen"; toggleScreenButton.classList.toggle('toggled-on', isScreenSharing); toggleScreenButton.classList.remove('toggled-off');} }

    async function performJoinRoom(roomIdToJoin) {
        if (!roomIdToJoin) { alert('Room ID is invalid.'); return; }
        if (!(typeof sessionUsername !== 'undefined' && sessionUsername) && localUserName.toLowerCase() === "guest") { if (guestNamePromptDiv) guestNamePromptDiv.style.display = 'flex'; if(guestNameInput) guestNameInput.focus(); alert("Please enter your name before joining."); return; }
        if (!localStream && !isScreenSharing) { await startLocalMedia(); if (!localStream && !isScreenSharing) { logMessage("Failed to start local media. Cannot join room."); alert("Could not start camera/mic. Check permissions."); return; } }
        if (currentRoomId && currentRoomId !== roomIdToJoin) { logMessage(`Leaving room ${currentRoomId} to join ${roomIdToJoin}`); cleanUpPeerConnections(); }
        else if (currentRoomId === roomIdToJoin) { logMessage(`Already in room ${currentRoomId}.`); return; }
        currentRoomId = roomIdToJoin; socket.emit('join', { room: currentRoomId, name: localUserName }); logMessage(`Attempting to join room: ${currentRoomId} as ${localUserName}`);
    }
    function cleanUpPeerConnections() { for (const sid in peerConnections) { if (peerConnections[sid]) peerConnections[sid].close(); const remoteVideoWrapper = document.getElementById(`video-wrapper-${sid}`); if (remoteVideoWrapper) remoteVideoWrapper.remove(); } Object.keys(peerConnections).forEach(key => delete peerConnections[key]); }
    function updateUIAfterJoin(roomIdJoined) { if(displayRoomId) displayRoomId.textContent = roomIdJoined; if(roomInfoDiv) roomInfoDiv.style.display = 'block'; if(createRoomBtn) createRoomBtn.style.display = 'none'; if(joinRoomBtn) joinRoomBtn.style.display = 'none'; if(roomIdInput) roomIdInput.style.display = 'none'; const orSpan = document.querySelector('.main-controls span'); if(orSpan) orSpan.style.display = 'none'; if(leaveRoomBtn) leaveRoomBtn.style.display = 'inline-block'; updateButtonStates(); }
    function resetUIAndStateAfterLeave() { currentRoomId = null; cleanUpPeerConnections(); if (isScreenSharing) stopScreenShareInternal(true); if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; if(localVideo) localVideo.srcObject = null; } originalVideoTrack = null; if (speechRecognition && isRecognizing) speechRecognition.stop(); isCcOn = false; isRecognizing = false; speechRecognitionRetries = 0; if(roomInfoDiv) roomInfoDiv.style.display = 'none'; if(displayRoomId) displayRoomId.textContent = ''; if(leaveRoomBtn) leaveRoomBtn.style.display = 'none'; if(createRoomBtn) createRoomBtn.style.display = 'inline-block'; if(joinRoomBtn) joinRoomBtn.style.display = 'inline-block'; if(roomIdInput) roomIdInput.style.display = 'inline-block'; if(roomIdInput) roomIdInput.value = ''; const orSpan = document.querySelector('.main-controls span'); if(orSpan) orSpan.style.display = 'inline'; if(messagesLog) messagesLog.innerHTML = ''; if(subtitlesDisplay) subtitlesDisplay.innerHTML = ''; isCameraOn = true; isMicOn = true; updateButtonStates(); if(createRoomBtn) createRoomBtn.disabled = true; if(joinRoomBtn) joinRoomBtn.disabled = true; logMessage("Left room. Ready to join/create."); localUserName = "Guest"; initializeUserName(); }

    socket.on('connect', () => { mySid = socket.id; logMessage('Connected.'); initializeUserName(); updateButtonStates(); });
    socket.on('disconnect', () => { logMessage('Disconnected.'); if (currentRoomId) resetUIAndStateAfterLeave(); });
    socket.on('my-sid', (data) => { mySid = data.sid; logMessage(`SID: ${mySid ? mySid.substring(0,6) : 'N/A'}`);});
    socket.on('joined-room', (data) => { mySid = data.sid; currentRoomId = data.room_id; logMessage(`Joined: ${data.room_id}. SID: ${data.sid ? data.sid.substring(0,6) : 'N/A'}`); updateUIAfterJoin(data.room_id); });
    socket.on('other-users', (data) => { if (!localStream && !screenStream) return; data.users.forEach(ud => { if (ud.sid !== mySid) createPeerConnection(ud.sid, true, ud.name || `User ${ud.sid.substring(0,6)}`); }); });
    socket.on('user-joined', (data) => { const {sid, name} = data; if (sid === mySid || (!localStream && !screenStream)) return; logMessage(`User ${name || sid.substring(0,6)} joined.`); createPeerConnection(sid, false, name || `User ${sid.substring(0,6)}`); });
    socket.on('user-left', (data) => { const remoteSid = data.sid; logMessage(`User ${data.name || remoteSid.substring(0,6)} left.`); if (peerConnections[remoteSid]) { peerConnections[remoteSid].close(); delete peerConnections[remoteSid]; } const remoteWrapper = document.getElementById(`video-wrapper-${remoteSid}`); if (remoteWrapper) remoteWrapper.remove(); });
    socket.on('signal', async (data) => { const { sender_sid, type, payload, name: senderNameFromSignal } = data; if (sender_sid === mySid) return; let pc = peerConnections[sender_sid]; if (!pc && type === 'offer') pc = createPeerConnection(sender_sid, false, senderNameFromSignal || `User ${sender_sid.substring(0,6)}`); else if (!pc) return; try { if (type === 'offer') { await pc.setRemoteDescription(new RTCSessionDescription(payload)); await processPendingCandidates(pc, sender_sid); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('signal', { target_sid: sender_sid, type: 'answer', payload: answer, name: localUserName }); } else if (type === 'answer') { await pc.setRemoteDescription(new RTCSessionDescription(payload)); await processPendingCandidates(pc, sender_sid); } else if (type === 'candidate' && payload) { if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(new RTCIceCandidate(payload)); else { if (!pc.pendingCandidates) pc.pendingCandidates = []; pc.pendingCandidates.push(payload); } } } catch (error) { console.error(`Signal error ${type} from ${sender_sid}:`, error); } });
    async function processPendingCandidates(pc, remoteSid) { if (pc && pc.pendingCandidates && pc.pendingCandidates.length > 0 && pc.remoteDescription && pc.remoteDescription.type) { while(pc.pendingCandidates.length > 0) { const candidate = pc.pendingCandidates.shift(); try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (error) { console.error(`Error adding buffered ICE for ${remoteSid}:`, error);}} } }
    socket.on('new-subtitle', (data) => { const { text, sender_sid, name } = data; if (sender_sid === mySid || !currentRoomId) return; displayUserSubtitle(text, name || `User ${sender_sid.substring(0,6)}`); });
    socket.on('error', (data) => { logMessage(`Server Error: ${data.message}`); alert(`Server Error: ${data.message}`); });

    function createPeerConnection(remoteSid, isInitiator, remoteName = `User ${remoteSid.substring(0,6)}`) {
        if (peerConnections[remoteSid]) return peerConnections[remoteSid];
        const pc = new RTCPeerConnection(iceConfiguration); peerConnections[remoteSid] = pc; pc.pendingCandidates = [];
        const streamToSend = screenStream || localStream;
        if (streamToSend) streamToSend.getTracks().forEach(track => { if ( (track.kind === 'video' && (isScreenSharing || (track.enabled && isCameraOn))) || (track.kind === 'audio' && (track.enabled && isMicOn)) ) try { pc.addTrack(track, streamToSend); } catch(e){console.error("Error adding track for ", remoteSid, e)} });
        else logMessage('Warning: No stream for PC to ' + remoteSid.substring(0,6));
        pc.onicecandidate = (event) => { if (event.candidate) socket.emit('signal', { target_sid: remoteSid, type: 'candidate', payload: event.candidate }); };
        pc.ontrack = (event) => {
            let remoteVideoWrapper = document.getElementById(`video-wrapper-${remoteSid}`); let remoteVideoEl = document.getElementById(`video-${remoteSid}`);
            if (!remoteVideoWrapper && videosContainer) {
                remoteVideoWrapper = document.createElement('div'); remoteVideoWrapper.id = `video-wrapper-${remoteSid}`; remoteVideoWrapper.className = 'video-wrapper';
                remoteVideoEl = document.createElement('video'); remoteVideoEl.id = `video-${remoteSid}`; remoteVideoEl.autoplay = true; remoteVideoEl.playsInline = true;
                const nameTag = document.createElement('p'); nameTag.className = 'participant-name-tag'; nameTag.textContent = remoteName;

                const maximizeBtnWrapper = document.createElement('div'); maximizeBtnWrapper.className = 'maximize-btn-wrapper';
                const maximizeBtn = document.createElement('button'); maximizeBtn.className = 'maximize-btn'; maximizeBtn.innerHTML = '⛶'; // Fullscreen symbol ⛶ (or use an SVG/icon font)
                maximizeBtn.title = "Maximize/Restore Video";
                maximizeBtn.onclick = () => toggleMaximizeVideo(remoteVideoWrapper, maximizeBtn);
                maximizeBtnWrapper.appendChild(maximizeBtn);

                remoteVideoWrapper.appendChild(remoteVideoEl);
                remoteVideoWrapper.appendChild(maximizeBtnWrapper); // Add maximize button
                remoteVideoWrapper.appendChild(nameTag);
                videosContainer.appendChild(remoteVideoWrapper);
                updateVideoLayout(); // Adjust layout after adding new video
            }
            if (remoteVideoEl) { if (event.streams && event.streams[0]) remoteVideoEl.srcObject = event.streams[0]; else { const s = new MediaStream(); s.addTrack(event.track); remoteVideoEl.srcObject = s; } }
        };
        pc.oniceconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) { if (peerConnections[remoteSid]) { peerConnections[remoteSid].close(); delete peerConnections[remoteSid]; } const wrapper = document.getElementById(`video-wrapper-${remoteSid}`); if (wrapper) wrapper.remove(); updateVideoLayout(); } };
        const originalSetRemote = pc.setRemoteDescription.bind(pc); pc.setRemoteDescription = async (d) => { await originalSetRemote(d); await processPendingCandidates(pc, remoteSid); };
        if (isInitiator) { if (!streamToSend) { if(peerConnections[remoteSid]) { peerConnections[remoteSid].close(); delete peerConnections[remoteSid]; } return pc; } pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => socket.emit('signal', { target_sid: remoteSid, type: 'offer', payload: pc.localDescription, name: localUserName })).catch(e => {console.error(`Offer error for ${remoteSid}:`, e); if(peerConnections[remoteSid]) { peerConnections[remoteSid].close(); delete peerConnections[remoteSid]; }}); }
        return pc;
    }

    function toggleMaximizeVideo(videoWrapper, btn) {
        const isMaximized = videoWrapper.classList.toggle('maximized');
        btn.innerHTML = isMaximized ? '✖' : '⛶'; // Close symbol / Fullscreen symbol
        // When one is maximized, you might want to visually 'minimize' others or hide them
        // This is a simple toggle for now.
        document.body.style.overflow = isMaximized ? 'hidden' : ''; // Prevent scrolling when maximized
        updateVideoLayout();
    }

    function updateVideoLayout() {
        const videoWrappers = videosContainer.querySelectorAll('.video-wrapper');
        const maximizedElement = videosContainer.querySelector('.video-wrapper.maximized');

        if (maximizedElement) {
            videoWrappers.forEach(vw => {
                if (vw !== maximizedElement) vw.style.display = 'none';
                else vw.style.display = 'flex'; // Ensure maximized is visible
            });
        } else {
            videoWrappers.forEach(vw => vw.style.display = 'flex'); // Show all
            if (videoWrappers.length === 1) {
                videoWrappers[0].classList.add('single');
            } else {
                videoWrappers.forEach(vw => vw.classList.remove('single'));
            }
        }
    }


    if(createRoomBtn) createRoomBtn.addEventListener('click', async () => { const newRoomId = generateRoomId(); if(roomIdInput) roomIdInput.value = newRoomId; await performJoinRoom(newRoomId); });
    if(joinRoomBtn) joinRoomBtn.addEventListener('click', async () => { const id = roomIdInput ? roomIdInput.value.trim() : ''; if (!id) { alert('Please enter Room ID.'); return; } await performJoinRoom(id); });
    if(leaveRoomBtn) leaveRoomBtn.addEventListener('click', () => { if (currentRoomId) { logMessage(`Leaving room ${currentRoomId}...`); socket.disconnect(); } });
    if(toggleCameraButton) toggleCameraButton.addEventListener('click', handleToggleCamera);
    if(toggleMicButton) toggleMicButton.addEventListener('click', handleToggleMic);
    if(toggleScreenButton) toggleScreenButton.addEventListener('click', handleToggleScreenShare);
    setupSubtitlesDisplayArea(); setupSpeechRecognition(); updateButtonStates();
});