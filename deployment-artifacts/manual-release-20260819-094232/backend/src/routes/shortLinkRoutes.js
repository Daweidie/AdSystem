const express = require('express');
const shortLinkController = require('../controllers/shortLinkController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// 手动生成短链；/create 保留为旧前端的兼容别名。
router.post('/generate', authenticate, shortLinkController.generateShortLink);
router.post('/create', authenticate, shortLinkController.generateShortLink);
router.post('/self-create', authenticate, shortLinkController.selfCreateShortLink);
router.post('/self-create-ab', authenticate, shortLinkController.createSelfAbTestLinks);

router.post('/toggle', authenticate, shortLinkController.toggleShortLink);
router.get('/list', authenticate, shortLinkController.listShortLinks);
router.get('/:id/stats', authenticate, shortLinkController.getShortLinkStats);
router.delete('/:id', authenticate, shortLinkController.deleteSelfShortLink);

// 自建短链跳转入口。生产环境可由 Nginx 将 /:code 转发到这里。
router.get('/:code', shortLinkController.redirectByCode);

module.exports = router;
