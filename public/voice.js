let system_message = null;
let message_history = [];
let state = 0; // 0 = wait, 1 = record, 2 = process

// This element is reused for multiple audio responses
let audioElem;

let audioChunks = [];

// Function to handle the file reading and byte conversion
function readFile(file) {
  const reader = new FileReader();
  const format = guessFormat(file.name);

  // Event listener for when the file has been read
  reader.onload = function(event) {
      const arrayBuffer = event.target.result;
      const byteArray = new Uint8Array(arrayBuffer);
      loadAudioBytes(byteArray, format);
  };

  // Read the file as an ArrayBuffer
  reader.readAsArrayBuffer(file);
}


function loadAudioBytes(bytes, format) {
  return loadAudioBlob(new Blob([bytes], { type: format }))
}

function loadAudioBlob(blob, format) {
  const url = URL.createObjectURL(blob);

  // Check if the audio element already exists
  if (!audioElem) {
      // Create a new audio element if it doesn't exist
      audioElem = new Audio();
      audioElem.controls = false; // Hide playback controls since it's invisible
      audioElem.style.display = 'none'; // Make the audio element invisible
      document.body.appendChild(audioElem); // Append only once
  }

  // Update the source of the audio element
  audioElem.src = url;

  // Play the audio
  audioElem.play()
      .catch(e => console.error('Error playing audio:', e));
}

function decodeBytes(base64Data) {
  // Decode the base64 string to a binary string
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);

  // Convert binary string to a Uint8Array
  for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}

// Function to guess the MIME type based on the file extension
function guessFormat(filename) {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      default: return 'application/octet-stream'; // Fallback type if unrecognized
  }
}


function getFormatExtension(mimeType) {
  const map = {
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
  };
  return map[mimeType] || '';
}

function processBlob(blob) {
  return new Promise(resolve => {
    // Get the extension for the blob type
    const ext = getFormatExtension(blob.type);
    
    // Use FileReader to convert Blob to Base64 string
    const reader = new FileReader();
    
    reader.onloadend = function() {
      // Extract raw base64 data from the result
      const base64Full = reader.result;
      const base64data = base64Full.split(',')[1];  // Remove the 'data:[<mediatype>][;base64],' part

      const CHUNK_SIZE = 1024;

      // https://stackoverflow.com/questions/7033639
      let chunks = base64data.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "g"));

      // Log the chunks
      resolve({chunks: chunks, extension: ext});
    };

    // Read the blob as a data URL to get a Base64-encoded string
    reader.readAsDataURL(blob);
  })
}





// Setup event listener for file input changes
/*
document.getElementById('fileInput').addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (file) {
        readFile(file);
    } else {
        console.log("No file selected!");
    }
});
*/

function loadInputElem() {
  // Get the textarea element by its ID
  var inputElem = document.getElementById('inputElem');

  // Add an event listener for the 'keydown' event
  inputElem.addEventListener('keydown', function(event) {
      // Check if the pressed key is 'Enter'
      if (event.key === 'Enter' || event.keyCode === 13) {
          event.preventDefault(); // Prevent the default action to stop from actually inserting a newline

          // Call the submitInput function with the current value of the textarea
          submitInputText(inputElem.value);

          // Clear the textarea
          inputElem.value = '';

          // Deselect the textarea
          inputElem.blur();
      }
  });
}

// Example implementation of the submitInput function
async function submitInputData(data) {
  let args = Object.assign({
    "history": message_history,
    "system_prompt": system_message,
  }, data || {});

  let res = await handle("scripts/37", args);
  message_history = res.history;

  showText(res.response);
  playAudioFile(res.file);
}

async function submitInputText(inputValue) {
  await submitInputData({message: inputValue});
}

async function submitAudio(blob) {
  let {chunks, extension} = await processBlob(blob);

  let filename = "voice-in." + extension;
  let stream = await handle('stream/create');

  let writeProm = handle('files/write', {
    path: filename,
    binary: true,
    content: stream,
  });

  for (let chunk of chunks) {
    await handle('stream/feed', {
      id: stream.id,
      data: chunk,
    });
  }

  await handle('stream/close', { id: stream.id });

  // Await for full file write
  await writeProm

  await submitInputData({
    "message": "",
    "voice_file": filename
  });
}

async function playAudioFile (filepath) {
  let res = await handle("files/read_stream", {"path": filepath});
  let streamId = res.stream.id;

  let stream = new Stream(streamId);
  let encoded = await stream.getContent();
  let bytes = decodeBytes(encoded);
  loadAudioBytes(bytes, guessFormat(filepath));
}

//myTest();
//loadInputElem();



// Access the user's microphone
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



function setState (newState) {
  state = newState;
  switch(state) {
    case 0:
      setButtonMode('record');
      break;
    case 1:
      setButtonMode('stop');
      break;
    case 2:
      setButtonMode('process');
      break;
  }
}


const mainButton = document.getElementById('mainButton');
const settingsButton = document.getElementById('settingsButton');

mainButton.addEventListener('click', async function() {
  switch (state) {
    case 0:
      if (startRecording()) {
        setState(1);
      } else {
        setState(0);
      }
      break;
    case 1:
      let blob = await stopRecording();
      setState(2);

      await submitAudio(blob);

      setState(0);
      break;
    case 2:
      // Do nothing while app is processing
      break;
  }
});

settingsButton.addEventListener('click', async function() {
  let p = prompt("Introduce un mensaje de sistema para el bot");
  if (p) {
    system_message = p;
    showText("El mensaje de sistema se ha actualizado correctamente");
  }
});