const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/checkin', require('./routes/checkin.routes'));

module.exports = app;
