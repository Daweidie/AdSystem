const express = require('express');
const controller = require('../controllers/managementController');
const { authenticate, allowRoles } = require('../middleware/auth');
const { uploadCardCover } = require('../services/cardCoverService');

const router = express.Router();

router.post('/auth/login', controller.login);
router.use(authenticate);
router.get('/auth/me', controller.me);
router.get('/dashboard', controller.dashboard);
router.get('/materials', controller.listMaterials);
router.put('/materials/:id', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.updateMaterial);
router.post(
  '/materials/:id/card-cover',
  allowRoles('super_admin', 'system_admin', 'business_manager'),
  uploadCardCover,
  controller.uploadMaterialCardCover,
);
router.put('/short-links/:id/card', controller.updateShortLinkCard);
router.post('/short-links/:id/card-cover', uploadCardCover, controller.uploadShortLinkCardCover);
router.get('/material-groups', controller.listMaterialGroups);
router.post('/material-groups', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.saveMaterialGroup);
router.put('/material-groups/:id', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.updateMaterialGroup);
router.delete('/material-groups/:id', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.deleteMaterialGroup);
router.get('/business-groups', controller.listBusinessGroups);
router.post('/business-groups', allowRoles('super_admin', 'system_admin'), controller.saveBusinessGroup);
router.put('/business-groups/:id', allowRoles('super_admin', 'system_admin'), controller.updateBusinessGroup);
router.get('/users', controller.listUsers);
router.post('/users', allowRoles('super_admin', 'system_admin'), controller.saveUser);
router.put('/users/:id', allowRoles('super_admin', 'system_admin'), controller.updateUser);
router.delete('/users/:id', allowRoles('super_admin', 'system_admin'), controller.deleteUser);
router.get('/expiring-users', controller.expiringUsers);
// 一般推广员只读本组额度；业务组管理员可调整本组，平台管理员可调整任意组。
router.get('/visit-quota', allowRoles('business_manager', 'general_user'), controller.getMyVisitQuota);
router.post('/visit-quota/add', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.addVisitQuota);
router.put('/visit-quota/base', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.updateVisitQuotaBase);
router.get('/visit-quotas', allowRoles('super_admin', 'system_admin'), controller.getVisitQuotas);
router.post('/visit-quotas/add', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.addVisitQuota);
router.put('/visit-quotas/base', allowRoles('super_admin', 'system_admin', 'business_manager'), controller.updateVisitQuotaBase);
router.put('/visit-quotas/per-employee', allowRoles('super_admin', 'system_admin'), controller.updateVisitQuotaPerEmployee);
// 兼容旧版前端的客户域名接口也必须遵循域名配置权限。
router.get('/customer-link', allowRoles('super_admin'), controller.getCustomerLink);
router.put('/customer-link', allowRoles('super_admin'), controller.saveCustomerLink);

module.exports = router;
