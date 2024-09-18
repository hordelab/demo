
//=== Audio Recording ===//

let mediaRecorder;
let audioChunks = [];

function startRecording() {
  return new Promise(async resolve => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = handleDataAvailable;
      mediaRecorder.start();
      mediaRecorder.onstart = () => {
        resolve(true);
      };
      mediaRecorder.onerror = () => {
        resolve(false);
      };
    } catch (error) {
      alert('Error accessing the microphone: ' + String(error));
      resolve(false);
    }
  });
}

function handleDataAvailable(event) {
  if (event.data.size > 0) {
    audioChunks.push(event.data);
  }
}

function stopRecording() {
  return new Promise(resolve => {
    mediaRecorder.stop();
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/ogg' });

      audioChunks = [];
      resolve(blob);
    };
  })
}
