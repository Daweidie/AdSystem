require('dotenv').config();

const app = require('./app');
const { startVideoExpiryScheduler } = require('./services/videoExpiryService');

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
  startVideoExpiryScheduler();
});
