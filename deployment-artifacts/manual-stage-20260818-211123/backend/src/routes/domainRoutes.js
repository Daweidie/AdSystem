const express = require('express');
const domainController = require('../controllers/domainController');
const { authenticate, allowRoles } = require('../middleware/auth');

const router = express.Router();
// 域名与缩链凭据属于系统级配置，只允许超级管理员维护。
router.use(authenticate, allowRoles('super_admin'));

// 将指定域名切换为当前主域名。
router.post('/switch', domainController.switchDomain);

// 获取全部域名及主域名、启用状态。
router.get('/list', domainController.listDomains);
router.get('/suolink-config', domainController.getSuolinkConfig);
router.put('/suolink-config', domainController.saveSuolinkConfig);
router.get('/delivery-readiness', domainController.getDeliveryReadiness);

router.post('/', domainController.createDomain);
router.put('/:id', domainController.updateDomain);
router.post('/:id/toggle', domainController.toggleDomain);
router.delete('/:id', domainController.deleteDomain);

module.exports = router;
