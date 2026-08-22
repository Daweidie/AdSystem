const express = require('express');
const videoController = require('../controllers/videoController');
const { authenticate, allowRoles } = require('../middleware/auth');

const router = express.Router();

// 获取腾讯云 VOD 客户端上传签名。
router.post('/upload', authenticate, allowRoles('super_admin', 'system_admin', 'business_manager'), videoController.getUploadSignature);

// Web 直传完成后登记 FileId，并设置腾讯云媒资 3 天过期时间。
router.post('/complete', authenticate, allowRoles('super_admin', 'system_admin', 'business_manager'), videoController.completeUpload);

// 管理后台视频列表。
router.get('/list', authenticate, videoController.listVideos);
router.get('/', authenticate, videoController.listVideos);

// Nginx/Vite 在返回 SPA 文档前调用的轻量访问校验。
router.get('/access', videoController.checkVideoAccess);

// 播放器事件上报。
router.post('/:id/events', videoController.reportPlaybackEvent);

// 云端媒资删除及本地软删除。
router.delete('/:id', authenticate, allowRoles('super_admin', 'system_admin', 'business_manager'), videoController.deleteVideo);

// 获取指定视频信息。
router.get('/:id', videoController.getVideoInfo);

module.exports = router;
