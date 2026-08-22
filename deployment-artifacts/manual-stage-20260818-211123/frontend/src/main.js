import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import {
  ElButton,
  ElDatePicker,
  ElDialog,
  ElEmpty,
  ElForm,
  ElInput,
  ElInputNumber,
  ElLoading,
  ElOption,
  ElProgress,
  ElSelect,
  ElSwitch,
} from 'element-plus';
import 'element-plus/dist/index.css';
import './styles/main.css';

const app = createApp(App);

[
  ElButton,
  ElDatePicker,
  ElDialog,
  ElEmpty,
  ElForm,
  ElInput,
  ElInputNumber,
  ElOption,
  ElProgress,
  ElSelect,
  ElSwitch,
].forEach((component) => app.component(component.name, component));

app.use(router).use(ElLoading).mount('#app');
