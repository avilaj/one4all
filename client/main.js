class ServerTime {
  constructor(intercommunication) {
    this.intercommunication = intercommunication;
    this.detour = undefined; // desvio
    this.maxSampleritems = 5;
    this.sampler = [];
  }
  getSampler() {
    const t = new Date();
    this.intercommunication.get('serverTime', ({ data }) => {
      const now = new Date();
      const latency = new Date() - t;

      this.sampler.push({
        serverTime: new Date(new Date(data).getTime() + (latency / 2)),
        localTime: now,
        latency,
      });

      if (this.sampler.length > this.maxSampleritems) {
        const latencyArray = this.sampler.map(item => item.latency);
        const maxLatency = Math.max(...latencyArray);
        this.sampler.splice(latencyArray.indexOf(maxLatency), 1);
      }
    });
  }
  get() {
    return this.calculateSeverTime(this.sampler, {});
  }
  getDetour() {
    const now = new Date();
    const values = this.sampler.map(
      sample => sample.serverTime.getTime() + (now - sample.localTime),
    );
    let acum = 0;

    for (let i = 0; i < values.length; i += 1) {
      acum += values[i];
    }

    const media = acum / values.length;
    acum = 0;
    for (let i = 0; i < values.length; i+= 1) {
      acum += Math.pow(values[i] - media, 2);
    }

    return Math.sqrt((1 / (values.length - 1)) * acum);
  }
  calculateSeverTime([sample, ...tail], { now = new Date(), samplerCount = 0, samplerAcum = 0 }) {
    if (sample) {
      const count = samplerCount + 1;
      const acum = samplerAcum + sample.serverTime.getTime() + (now - sample.localTime);
      return this.calculateSeverTime(tail, { now, samplerCount: count, samplerAcum: acum });
    }
    return samplerAcum / samplerCount;
  }
  startSynchronization() {
    setTimeout(() => {
      this.getSampler();
      this.startSynchronization();
    }, 1000);
  }

}

class Intercommunication {
  constructor(url) {
    this.socket = io(url);
    // this events requires the petition of the client
    this.eventList = ['serverTime', 'currentTrack', 'timeCurrentTrack', 'addSong', 'playMusic', 'pauseMusic', 'nextMusic', 'sendMessage'];
    // these events are fired by the server
    this.eventSubscribe = ['startPlay', 'stopPlay', 'playList', 'numberOfConections', 'activityStream'];

    this.pendingMessages = [];
    this.subscribers = [];

    this.processCallbacks = (eventName, data) => {
      this.pendingMessages.forEach((message, index) => {
        if (message.guid === data.guid) {
          if (typeof message.callback ===  'function') {
            message.callback(data);
          }
          this.pendingMessages.splice(index, 1);
        }
      });
    };

    this.eventList.forEach((eventName) => {
      this.socket.on(`${eventName}-S`, (data) => {
        this.processCallbacks(eventName, data);
      });
    });

    this.processHandlers = (eventName, data) => {
      this.subscribers.forEach((subscribe) => {
        if (subscribe.eventName === eventName) {
          subscribe.handler(data);
        }
      });
    };
    this.eventSubscribe.forEach((eventName) => {
      this.socket.on(`${eventName}`, (data) => {
        this.processHandlers(eventName, data);
      });
    });
  }
  get(eventName, callback, data) {
    const guid = Math.floor(Math.random() * 1000000);

    if (~this.eventList.indexOf(eventName)) {
      this.pendingMessages.push({
        guid,
        callback,
      });
      this.socket.emit(eventName, {
        guid,
        data,
      });
    } else {
      console.warn(`The event '${eventName}' is not defined`);
    }
  }
  subscribe(eventName, handler) {
    const subs = {
      eventName,
      handler,
    };

    this.subscribers.push(subs);

    return subs;
  }
  unsubscribe(reference) {
    this.subscribers.splice(this.subscribers.indexOf(reference), 1);
  }
}

class AudioPlayer {
  constructor(intercommunication, serverTime, percentEl) {
    this.intercommunication = intercommunication;
    this.percentEl = percentEl;
    // initialize audio control
    this.audioElement = window.document.createElement('AUDIO');
    if (isMobile()) {
      this.audioElement.controls = true;
    }
    this.src = './beep.mp3';
    window.foo = this.audioElement;
    this.serverTime = serverTime;

    window.document.body.appendChild(this.audioElement);
    // status = 0 -> no initialized 1 -> requesting current track 2 -> downloading file  4 -> track loaded
    this.status = 0;
    this.cachedSongs = {};
  }
  loadAudio(playList) {
    this.status = 1;
    this.setSong(undefined);
    this.intercommunication.get('currentTrack', ({ data }) => {
      if (data) {
        if (this.cachedSongs[data]) {
          this.setSong(this.cachedSongs[data]);
          this.status = 4;
        } else {
          this.downloadSong(data).then(() => {
            this.loadAudio(playList);
          });
        }
        const nextTrack = playList[playList.indexOf(data) + 1];
        if (nextTrack) {
          this.downloadSong(nextTrack);
        }
      } else {
        console.error('The play list looks like empty dude :(');
      }
    });
  }
  downloadSong(filename) {
    return new Promise((resolve) => {
      this.status = 2;
      const xhttp = new XMLHttpRequest();
      xhttp.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = Math.round((e.loaded / e.total) * 100);
          this.percentEl.innerHTML = `${filename} - ${percentComplete}`;
          console.log(`Downloading: (${filename}) ${percentComplete}%`);
        }
      });

      xhttp.addEventListener('load', () => {
        if (xhttp.status == 200) {
          const tmpUrl = window.URL.createObjectURL(xhttp.response);
          this.cachedSongs[filename] = tmpUrl;
          this.status = 4;
          resolve();
        }
      });

      xhttp.open('GET', filename);
      xhttp.responseType = 'blob';
      xhttp.send();
    });
  }
  setSong(songURL = '') {
    this.audioElement.src = songURL;
  }
  seek(time) {
    this.audioElement.currentTime = time / 1000;
  }
  play() {
    this.intercommunication.get('timeCurrentTrack', ({ data }) => {
      const { serverTime, trackTime } = data;

      const delay = 2000;
      const timeDifference = Math.round(new Date(serverTime).getTime() + delay) - this.serverTime.get();

      if (timeDifference >= 0 && !Number.isNaN(this.serverTime.getDetour())) {
        setTimeout(() => {
          console.log('DIFF', (trackTime + delay) - this.audioElement.currentTime * 1000);
          this.seek(trackTime + delay);
          const initialTime = new Date();
          // 100ms looping to have a better performance
          while (new Date() - initialTime < 100) {}
          this.audioElement.play();
        }, timeDifference - 100);
      } else {
        console.error('You have too much delay dude :(');
      }
    });
  }
  waitForPlay() {
    this.intercommunication.subscribe('startPlay', () => {
      console.log('PLAY');
      this.play();
    });
    this.intercommunication.subscribe('stopPlay', () => {
      console.log('STOP');
      this.stop();
    });
  }
  stop() {
    this.audioElement.pause();
  }
}

class PlayList {
  constructor(id, intercommunication, audioPlayer) {
    this.intercommunication = intercommunication;
    this.audioPlayer = audioPlayer;
    this.songs = [];
    this.currentSong = 0;
    this.id = id;
  }
  get() {

  }
  addSong(url) {
    console.log('Sending song...');
    window.document.getElementById('loading').style.display = 'block';
    this.intercommunication.get('addSong', () => {
      console.log('Song added propertly');
      window.document.getElementById('loading').style.display = 'none';
    }, {
      url,
    });
  }
  waitForPlayList() {
    this.intercommunication.subscribe('playList', ({ data }) => {
      const { songs, currentSong } = data;
      this.songs = songs;

      if (this.currentSong !== currentSong) {
        this.audioPlayer.loadAudio(this.songs);
        this.audioPlayer.stop();
      }

      this.currentSong = currentSong;

      this.render();
    });
  }
  waitForNumberOfConections() {
    this.intercommunication.subscribe('numberOfConections', ({ data }) => {
      window.document.getElementById('userConected').innerHTML = data.length;
    });
  }
  render() {
    let el = `
    <span>
      Playing: <b>${this.currentSong}</b>
    </span>`;

    for (let i = 0; i < this.songs.length; i += 1) {
      const song = this.songs[i];
      el += `
      <ul>
        <li>${song}</li>
      </ul>
      `;
    }
    window.document.getElementById(this.id).innerHTML = el;
  }
}
class Chat {
  constructor(intercommunication) {
    this.intercommunication = intercommunication;
  }
  waitForActivityStream() {
    this.intercommunication.subscribe('activityStream', ({ data }) => {
      this.addActivity(data.message);
    });
  }
  sendMessage(message, userName) {
    window.document.getElementById('loading').style.display = 'block';
    this.intercommunication.get('sendMessage', ({ data }) => {
      window.document.getElementById('loading').style.display = 'none';
    }, {
      message,
      userName,
    });
  }
  addActivity(message) {
    window.document.getElementById('activityStream').innerHTML += `${message} <br/>`;
  }
}
class App {
  constructor() {
    const percentEl = window.document.getElementById('percent');

    this.intercommunication = new Intercommunication(configuration.server);
    this.serverTime = new ServerTime(this.intercommunication);
    this.audioPlayer = new AudioPlayer(this.intercommunication, this.serverTime, percentEl);
    this.playList = new PlayList('playList', this.intercommunication, this.audioPlayer);
    this.chat = new Chat(this.intercommunication);

    this.serverTime.startSynchronization();

    // this.audioPlayer.loadAudio();
    this.playList.waitForPlayList();
    this.playList.waitForNumberOfConections();
    this.chat.waitForActivityStream();

    const timer = setInterval(() => {
      if (this.serverTime.getDetour() < configuration.maxDetour) {
        console.log('I know the server time ;) with this detour: ', this.serverTime.getDetour());
        // here I know the server time
        this.audioPlayer.waitForPlay();
        clearInterval(timer);
      }
    }, 1000);
  }
  addSongToPlayList(songUrl) {
    this.playList.addSong(songUrl);
  }
  play() {
    this.intercommunication.get('playMusic');
  }
  pause() {
    this.intercommunication.get('pauseMusic');
  }
  next() {
    this.intercommunication.get('nextMusic');
  }
  sendMessage(message, userName) {
    this.chat.sendMessage(message, userName);
  }
}


// //////////////////////////////////////////////
// //////////////////////////////////////////////
// application starts

const app = new App();


function addSongToPlayList() {
  const songUrl = window.document.getElementById('urlSong').value;
  if (songUrl) {
    app.addSongToPlayList(songUrl);
  } else {
    window.alert('Why so rude?');
  }
}

function playMusic() {
  app.play();
}
function pauseMusic() {
  app.pause();
}
function nextMusic() {
  app.next();
}
function sendMessage() {
  const message = window.document.getElementById('messageText').value;
  const userName = window.document.getElementById('userName').value;
  if (userName.length) {
    app.sendMessage(message, userName);
    window.document.getElementById('messageText').value = '';
    window.document.getElementById('userName').disabled = true;
  } else {
    window.alert('Hey dude!, don\'t forget your name');
  }
}
function isMobile() {
  var check = false;
  (function(a){if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4))) check = true;})(navigator.userAgent||navigator.vendor||window.opera);
  return check;
}