const express = require('express');
const statisticsController = require('../controllers/statisticsController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/shortlink', statisticsController.getShortLinkStatistics);

module.exports = router;
