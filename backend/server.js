require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const app = require('./app');
const { initSchema } = require('./db/schema');
const schedulers = require('./services/schedulers');

const PORT = process.env.PORT || 3001;

initSchema()
  .then(() => {
    schedulers.startAll();
    app.listen(PORT, () => {
      console.log(`Resolvd backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Schema init failed:', err);
    process.exit(1);
  });
