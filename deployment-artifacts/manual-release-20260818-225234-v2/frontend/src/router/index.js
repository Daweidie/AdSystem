import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import Admin from '../views/Admin.vue';
import Play from '../views/Play.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/admin',
      name: 'admin',
      component: Admin,
      meta: { requiresAuth: true },
    },
    {
      path: '/play',
      name: 'play',
      component: Play,
    },
  ],
});

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !localStorage.getItem('demo18_token')) {
    return { name: 'home' };
  }
  if (to.name === 'home' && localStorage.getItem('demo18_token')) {
    return { name: 'admin' };
  }
  return true;
});

export default router;
