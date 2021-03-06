// server.js
// where your node app starts

// init project
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const app = express();
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const slack = require('./helpers/slack');
const spotify = require('./helpers/spotify');
const color = require('./helpers/color');
const image = require('./helpers/image');

app.use("/public", express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', async function (req, res) {
  res.send("Welcome to Paystack Music!");
});

app.get('/authorize', async function (req, res) {
  const authURL = spotify.createAuthURL();
  const html = `
    <!DOCTYPE html>
    <html>
      <head></head>
      <body>
        <h1>Hello!</h1>
        <p>Please make sure you're logged into Paystack's Community Spotify</p>
        <a target="_blank" href="${authURL}">Click here to authorize</a>
      </body>
    </html>
  `;
  res.send(html);
});

app.get('/callback', async function (req, res) {
  try {
    const code = req.query.code;
    const response = await spotify.getTokensFromAPI(code);

    spotify.setTokensInDB(response);
    spotify.setTokensOnAPIObject(response);

    const html = `
      <!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <h1>All done!</h1>
          <a target="_blank" href="${process.env.APP_TRIGGER_URI}">Click here to trigger everything</a>
        </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    res.send(JSON.stringify(error));
  }
});

app.post('/trigger', async function (req, res) {
  try {
    const dateYear = req.body.year;
    const dateMonth = Number(req.body.month) < 10 ? `0${Number(req.body.month)}` : req.body.month;
    const dateDay = Number(req.body.day) < 10 ? `0${Number(req.body.day)}` : req.body.day;
    
    const date = `${dateYear}-${dateMonth}-${dateDay}`;
    const playlistMonth = moment(date).subtract(1, 'months');
    const playlistName = playlistMonth.format('MMMM YYYY');

    const history = await slack.fetchChannelHistory(playlistMonth);
    
    if (!history.messages) {
      res.send('Could not find any messages. Please check the channel and try again.');
      return
    }

    const spotifyMessages = slack.filterSpotifyMessages(history.messages);
    const tracks = slack.filterSpotifyTracks(spotifyMessages);

    const tokens = spotify.getTokensFromDB();

    // check if there are valid tokens in our DB
    if (tokens.refreshToken) {
      const oneHour = 1000 * 60 * 60; 
      const isTokenValid = (Date.now() - tokens.timestamp) < oneHour;
      spotify.setTokensOnAPIObject(tokens);

       // refresh access token if old one has expired
      if (!isTokenValid) {
        const accessToken = await spotify.refreshAccessTokenFromAPI(); 
        spotify.setAccessTokenInDB(accessToken);
        spotify.setAccessTokenOnAPIObject(accessToken);
      }
     
      // create new playlist
      let playlist = await spotify.createPlaylist(playlistName);

      // and songs to playlist
      const trackURIs = tracks.map(track => `spotify:track:${track.id}`);
      
      // upload in batches of 99 
      const batchSize = 99;
      for (let i = 0; i < trackURIs.length; i += batchSize) {
          let batch = trackURIs.slice(i,i + batchSize);
          await spotify.addTracksToPlaylist(playlist.id, batch);
      }
      
      // get playlist cover art
      playlist = await spotify.getPlaylist(playlist.id);
      const coverImageUrl = playlist.images[0].url;

      // pick color from current cover art
      const dominantColor = await color.getBackgroundColorFromImage(coverImageUrl);
      
      // create new cover art
      const newCoverImage = await image.generateCoverImage({
        color: dominantColor,
        month: playlistMonth.format('MMMM'),
        year: playlistMonth.format('YYYY')
      });

      // attach album art to playlist
      await spotify.setPlaylistCover(playlist.id, newCoverImage);

      // send playlist to slack
      await slack.sendMessage(playlist.external_urls.spotify, process.env.SLACK_CHANNEL);
      await slack.sendMessage(`There were ${history.messages.length} messages in the music channel for ${playlistMonth.format('MMMM')} ${playlistMonth.format('YYYY')}`);

      // finish
      res.send(`${playlistName} playlist, check spotify (or your Slack DMs if you're Kachi :))`);
    } else {
      await slack.sendMessage("I couldn't authorize and create this month's playlist");
      res.send('Omo, there were no tokens there o. Try authorizing <a href="/authorize">here</a> first.');
    } 
  } catch (error) {
    const e = { message: error.message, stack: error.stack };
    await slack.sendMessage(JSON.stringify(e));
    console.log(error);
    res.send(JSON.stringify(e));
  }
});

app.get('/covers', function (req, res) {
  res.sendFile(path.join(__dirname+'/views/covers.html'));
});

app.post('/webhook', function (req, res) {
  
});


// listen for requests :)
const listener = app.listen(process.env.PORT, function () {
  console.log('Your app is listening on port ' + listener.address().port);
});
