const express = require('express');
const controller = require('../controllers/internalSyncController');
const { authenticateWorker } = require('../middleware/serviceAuth');

const router = express.Router();
router.use(authenticateWorker);
router.post('/short-links/:shortCode/click', controller.recordShortLinkClick);

module.exports = router;
