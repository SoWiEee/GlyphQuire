import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router/index.js";
import "./themes/tokens.css";
import "./themes/components/heading.css";
import "./themes/components/quote.css";
import "./themes/components/callout.css";
import "./themes/components/code.css";
import "./themes/components/toggle.css";
import "./themes/components/tabs.css";
import "./themes/components/sticky-note.css";
import "./themes/components/columns.css";
import "./themes/components/divider.css";
import "./themes/components/image.css";
import "./themes/components/math.css";
import "./themes/components/paragraph.css";
import "./styles/workbench.css";

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount("#app");
