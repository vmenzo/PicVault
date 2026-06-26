import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ElAlert } from 'element-plus/es/components/alert/index';
import {
  ElAside,
  ElContainer,
  ElHeader,
  ElMain,
} from 'element-plus/es/components/container/index';
import { ElButton } from 'element-plus/es/components/button/index';
import { ElCard } from 'element-plus/es/components/card/index';
import { ElCheckbox } from 'element-plus/es/components/checkbox/index';
import {
  ElDescriptions,
  ElDescriptionsItem,
} from 'element-plus/es/components/descriptions/index';
import { ElDialog } from 'element-plus/es/components/dialog/index';
import { ElDrawer } from 'element-plus/es/components/drawer/index';
import {
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
} from 'element-plus/es/components/dropdown/index';
import { ElEmpty } from 'element-plus/es/components/empty/index';
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index';
import { ElIcon } from 'element-plus/es/components/icon/index';
import { ElInput } from 'element-plus/es/components/input/index';
import { ElInputNumber } from 'element-plus/es/components/input-number/index';
import { ElLoading } from 'element-plus/es/components/loading/index';
import { ElMenu, ElMenuItem } from 'element-plus/es/components/menu/index';
import { ElPagination } from 'element-plus/es/components/pagination/index';
import { ElProgress } from 'element-plus/es/components/progress/index';
import { ElSegmented } from 'element-plus/es/components/segmented/index';
import { ElOption, ElSelect } from 'element-plus/es/components/select/index';
import { ElSlider } from 'element-plus/es/components/slider/index';
import { ElSwitch } from 'element-plus/es/components/switch/index';
import { ElTabPane, ElTabs } from 'element-plus/es/components/tabs/index';
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index';
import { ElTag } from 'element-plus/es/components/tag/index';
import { ElUpload } from 'element-plus/es/components/upload/index';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import { router } from './router';

const app = createApp(App);
const elementComponents = [
  ElAlert,
  ElAside,
  ElButton,
  ElCard,
  ElCheckbox,
  ElContainer,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElLoading,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElProgress,
  ElSegmented,
  ElSelect,
  ElSlider,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElUpload,
];

app.use(createPinia());
app.use(router);
for (const component of elementComponents) {
  app.use(component);
}

app.mount('#app');
