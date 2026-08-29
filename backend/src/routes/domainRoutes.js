const express = require('express');
const multer = require('multer');
const domainController = require('../controllers/domainController');
const { authenticate, allowRoles } = require('../middleware/auth');

const router = express.Router();
const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, callback) => {
    if (['certificate', 'privateKey'].includes(file.fieldname)) return callback(null, true);
    const error = new Error('仅支持 certificate 和 privateKey 两个证书文件字段');
    error.status = 400;
    return callback(error);
  },
});
// 域名与缩链凭据属于系统级配置，只允许超级管理员维护。
router.use(authenticate, allowRoles('super_admin'));

// 将指定域名切换为当前主域名。
router.post('/switch', domainController.switchDomain);

// 获取全部域名及主域名、启用状态。
router.get('/list', domainController.listDomains);
router.get('/card-domain-config', domainController.getCardDomainConfig);
router.get('/suolink-config', domainController.getSuolinkConfig);
router.put('/suolink-config', domainController.saveSuolinkConfig);
router.get('/delivery-readiness', domainController.getDeliveryReadiness);
router.get('/:id/certificate', domainController.getCertificateConfig);
router.post('/:id/certificate', certificateUpload.fields([
  { name: 'certificate', maxCount: 1 },
  { name: 'privateKey', maxCount: 1 },
]), domainController.uploadCertificate);

router.post('/', domainController.createDomain);
router.put('/:id', domainController.updateDomain);
router.post('/:id/toggle', domainController.toggleDomain);
router.delete('/:id', domainController.deleteDomain);

module.exports = router;
