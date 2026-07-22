import type {
  AboutPageContent,
  AgentPageContent,
  BlogPageContent,
  BlogPost,
  HomePageContent,
  MusicPlayerContent,
  Project,
  ShowcasePageContent,
  SiteSettings,
  TechStackGroup,
} from './types';

const AURA_PROJECT_URL = 'https://www.beta-demo.top';

export const PERSONAL_INFO = {
  name: "Beta-Demo777",
  title: "Full-Stack & AI Application Developer",
  bio: "专注于 Java/Python 全栈开发、AI 应用工程与云原生部署。通过 RAG、Agent、MCP 与可观测性体系，将模型能力构建为稳定、可测试、可交付的产品。",
  location: "Shanghai, China",
  email: "",
  github: "https://github.com/Beta-demo777",
  twitter: "",
  experience: [
    { year: "2024 - Present", role: "Principal Engineer at InteractionLab", desc: "主导下一代富交互画布引擎的重构，GPU渲染性能提升180%" },
    { year: "2022 - 2024", role: "Senior Frontend Dev at Vercel (Contract)", desc: "优化框架层面的动画加载机制与静态资源缓存，探索端到端流式渲染" },
    { year: "2020 - 2022", role: "UI Engineer at ByteDance", desc: "负责创意终端实验室项目，实现复杂的可视化大屏与交互动效库" }
  ]
};

export const SITE_SETTINGS: SiteSettings = {
  siteTitle: "Beta-Demo777 | Full-Stack & AI Application Developer",
  siteDescription: "Beta-Demo777 的个人作品集、技术博客与 AI 应用项目展示。",
  brandInitials: "BD",
  navigation: [
    { id: "home", label: "首页 Home" },
    { id: "showcase", label: "作品集 Portfolio" },
    { id: "blog", label: "博客 Journal" },
    { id: "agent", label: "智能体 Agent" },
    { id: "about", label: "关于我 About" },
  ],
  footerCopyright: "© {year} {name}. Crafted with precision & code.",
  footerBadges: ["Security", "Performance: 100%", "Minimalist Theme"],
  icpNumber: "粤ICP备2026094720号-1",
  icpUrl: "https://beian.miit.gov.cn/",
};

export const HOME_PAGE: HomePageContent = {
  greetings: ["HELLO WORLD", "你好，世界", "BONJOUR MONDE", "こんにちは世界", "DESIGN WITH CODE"],
  heroPrefix: "构建由",
  heroHighlight: "代码与艺术",
  heroSuffix: "编织的数字宇宙",
  introduction: "我是 Beta-Demo777，一名全栈与 AI 应用开发者。专注于 Java/Python 服务端、React 前端、数据与缓存、可观测性体系，以及 RAG、Agent、MCP 等 AI 工程能力。",
  highlights: [
    { id: "full-stack", title: "Full Stack", description: "Java、Python、Spring Boot 3、FastAPI 与 React", icon: "code" },
    { id: "ai-engineering", title: "AI Engineering", description: "RAG、Prompt、MCP Server、Agent Skills 与 SDD", icon: "layers" },
    { id: "cloud-native", title: "Cloud Native", description: "Docker、Nginx、Prometheus、Grafana 与 ARMS", icon: "sparkles" },
  ],
  portfolioButton: "浏览作品集 View Portfolio",
  agentButton: "对话 AI 智能体 Chat Agent",
  blogButton: "技术博客 Read Blog",
};

export const SHOWCASE_PAGE: ShowcasePageContent = {
  identityLabel: "Developer Identity",
  terminalWelcome: "Welcome to Beta-Demo777's Portfolio Terminal v1.4.0.",
  terminalHint: "Type \"help\" or click one of the quick command tags below to explore.",
  terminalTitle: "interactive shell",
  terminalPlaceholder: "Type command here (e.g. help)...",
  technologyTitle: "Technology Matrix",
  worksEyebrow: "Selected Works",
  worksTitle: "项目作品集",
  terminalPrompt: "beta-demo777 ~ $",
  quickLabel: "Quick:",
  allFilterLabel: "all",
  terminalHelp: [
    "Available commands:",
    "  bio          - Show detailed personal biography",
    "  skills       - Print key tech stack and proficiency ratings",
    "  experience   - Display past roles and achievements",
    "  contact      - Print social links and contact emails",
    "  projects     - List current portfolio projects",
    "  clear        - Flush terminal history",
  ],
  commandNotFound: "Command not found. Type \"help\" for a list of commands.",
  detailsLabel: "了解详情",
  repositoryLabel: "Repository",
  livePreviewLabel: "Live Preview",
  impactLabel: "Impact Metric",
  starsLabel: "GitHub Stars",
  forksLabel: "Forks",
};

export const BLOG_PAGE: BlogPageContent = {
  eyebrow: "Tech Journal & Notes",
  title: "技术深度解析",
  description: "分享在 WebGL 性能调优、创意微交互物理学、以及现代 React/CSS 架构演进中的探索与真知。",
  searchPlaceholder: "搜索文章、标签...",
  noResultsText: "No matching articles found.",
  backLabel: "Back to journal",
  relatedTitle: "Related Readings",
  allCategoryLabel: "all",
  readsLabel: "Reads",
  likeLabel: "喜欢",
  linkCopiedLabel: "Link Copied!",
};

export const ABOUT_PAGE: AboutPageContent = {
  eyebrow: "Behind the Pixels",
  title: "关于我 About Beta-Demo777",
  description: "一个完美主义者的日常：用极致的代码美学重塑前端感官认知，让设计与逻辑在屏幕中自由流淌。",
  introductionTitle: "自我介绍",
  introduction: [
    "拥有良好的沟通和协调能力，热爱软件开发与技术创新，具备全栈开发能力，熟悉 React + Spring Boot 技术体系及 DevOps 工具链，擅长 Cursor、Codex、Claude Code、N8N、ComfyUI、Ollama 等 AI 工具的应用，对计算机技术有浓厚兴趣，持续关注互联网技术前沿。",
    "日常探索 RAG、Prompt、MCP Server、AI Agent Skills、Harness 等新技术的使用。具备强自学能力与解决问题的热情，努力成为一名优秀的软件工程师。",
  ],
  experienceTitle: "工作经历 Timeline",
  hobbiesTitle: "多元日常 & 趣事",
  hobbies: [
    { id: "coffee", title: "手冲咖啡", description: "耶加雪菲 | 中浅烘焙", icon: "coffee" },
    { id: "open-source", title: "开源贡献", description: "WebGL Shader 拥趸", icon: "code" },
    { id: "games", title: "独立游戏", description: "深空之眼 | 机械迷城", icon: "game" },
    { id: "science-fiction", title: "科幻影视", description: "爱死机 | 沙丘世界观", icon: "screen" },
  ],
  technologyTitle: "技术栈 Technology Stack",
  contactEyebrow: "Secure Signal Terminal",
  contactTitle: "建立安全连接",
  contactDescription: "填写信息后将在你的默认邮件客户端中创建草稿，本站不会直接发送消息。",
  contactNamePlaceholder: "Your Name / 阁下称呼",
  contactMessagePlaceholder: "Write message / 输入传输指令...",
  contactSendingLabel: "OPENING MAIL CLIENT...",
  contactSuccessLabel: "DRAFT READY",
  contactSubmitLabel: "CREATE EMAIL DRAFT",
};

export const AGENT_PAGE: AgentPageContent = {
  title: "AZ-01 智能融合终端",
  description: "搭载三维数字虚拟化 Live2D 人形交互界面，结合 Gemini 大语言模型，为您呈现沉浸式的数字交流体验。",
  welcomeMessage: "你好！我是 Beta-Demo777 的 **AI 智能分身**。\n\n我了解他的全栈技术栈、AI 应用能力、项目实践与工程方法。你可以随时向我提问：\n\n- 💻 **Java / Python / React 全栈开发**\n- 🤖 **RAG、MCP、Agent 与 AI 开发框架**\n- 🚀 **Docker、可观测性与质量工程**\n\n你想从哪里开始了解？",
  initialBubble: "你好呀！有什么想问我的吗？",
  loadingBubble: "让我接入知识库搜寻一下，马上回答你哦...",
  answeredBubble: "答案已经同步到右侧对话框啦，快去看看吧！",
  resetBubble: "对话已重置！我们重新开始聊聊吧~",
  inputPlaceholder: "输入你想了解的问题...",
  displayName: "{name} AI",
  badgeLabel: "Live Agent",
  modelLabel: "Gemini AI Core",
  idleStatus: "STANDBY ONLINE",
  loadingStatus: "COGNITIVE PROCESSING",
  interactionHint: "点击数字人可触发互动",
  suggestionsTitle: "Suggestions",
  resetLabel: "Reset",
  samplePrompts: [
    { text: "介绍一下 Beta-Demo777 的工作背景", label: "工作背景" },
    { text: "介绍一下 Aura AI 角色扮演项目", label: "代表项目" },
    { text: "Beta-Demo777 擅长哪些 AI 应用技术？", label: "AI 能力" },
    { text: "如何快速联系 Beta-Demo777？", label: "联系方式" },
  ],
  funQuotes: [
    "嗨！我是 Beta-Demo777 的数字替身，正在为你保驾护航 🟢",
    "戳一戳脑袋，今天的代码 Bug 就会减少 50% 喔！",
    "正在持续加载量子认知芯片中... 🧠💡",
    "嘿，不要用鼠标频繁戳我的精密视网膜传感器啦！🤖",
    "思考中：如何让 Web 动效像真实物理世界一样自然？🌊",
    "滴滴... 正在为你加速接通 Beta-Demo777 的数字大脑神经元！",
    "今天的编译非常顺利，空气中弥漫着优雅代码的味道~",
  ],
};

export const MUSIC_PLAYER: MusicPlayerContent = {
  title: "Ambient Synthesizer",
  minimizedLabel: "Ambient Synth Engine",
  standbyLabel: "ENGINE STANDBY",
  playingPrefix: "Playing:",
  tracks: [
    { id: "cosmic", name: "Cosmic Drone", description: "Deep space low-frequency resonance for deep focus.", type: "synth", frequency: 110 },
    { id: "binaural", name: "Binaural Focus", description: "Alpha-wave brain state synchronization chords.", type: "synth", frequency: 165 },
    { id: "zen", name: "Zen Garden", description: "Warm organic FM bell synthesis wave.", type: "synth", frequency: 220 },
  ],
};

export const TECH_STACK_GROUPS: TechStackGroup[] = [
  { id: "backend", title: "后端", items: ["Java", "Python", "Spring Boot 3", "MyBatis-Plus", "FastAPI"] },
  { id: "frontend", title: "前端", items: ["HTML", "CSS", "JavaScript", "React"] },
  { id: "database", title: "数据库与缓存", items: ["MySQL", "PostgreSQL", "Redis"] },
  { id: "quality", title: "测试与质量", items: ["Postman", "JMeter", "JaCoCo", "SonarQube"] },
  { id: "devops", title: "部署与运维", items: ["Docker", "Nginx", "Prometheus", "Grafana", "阿里云 ARMS 监控告警体系"] },
  { id: "version-control", title: "版本管理", items: ["Git", "GitHub"] },
  { id: "optimization", title: "引擎优化", items: ["SEO", "GEO"] },
  { id: "ai-framework", title: "AI 开发框架", items: ["LangChain4j", "Spring AI"] },
  { id: "ai-capability", title: "AI 应用能力", items: ["RAG", "Prompt", "MCP Server", "AI Agent Skills", "Harness", "SDD"] },
  { id: "tools", title: "环境与工具", items: ["VSCode", "Cursor", "Codex", "Claude Code", "N8N", "ComfyUI", "Ollama"] }
];

export const PROJECTS: Project[] = [
  {
    id: "aura-roleplay",
    title: "Aura AI 角色扮演",
    description: "支持角色、场景、多套用户人设与对话线程的中文 AI 角色扮演应用，提供可配置的 OpenAI-compatible 模型服务。",
    longDescription: "Aura 是一个完整的前后端 AI 角色扮演项目。React 前端负责角色、场景、人设和对话体验，Express 代理用户配置的模型服务，FastAPI 提供 PostgreSQL 持久化、认证与 Redis 基础设施能力。项目支持模型密钥加密存储、对话状态同步、语音播放和响应式工作区。",
    tags: ["React 19", "FastAPI", "PostgreSQL", "Docker"],
    url: AURA_PROJECT_URL,
    github: "https://github.com/Beta-demo777/ai-assistant-platform",
    stats: { impact: "Full-stack AI roleplay workspace" },
    featured: true,
    role: "Full-stack Developer",
    year: "2026"
  },
  {
    id: "quantum-canvas",
    title: "Quantum Canvas Render Engine",
    description: "基于 WebGL 2.0 构建的极简高性能粒子流体模拟引擎，支持10万个粒子在60帧下进行物理交互。",
    longDescription: "这是一个专注于浏览器端物理粒子和流体计算的高性能渲染引擎。它使用原生 WebGL 2.0 着色器进行 GPU 并行加速，利用对冲算法模拟流体物理行为。界面提供完整可视化控制面板，让交互触手可及。核心性能表现超越了大多数同类 2D Canvas 库，被用于多个创意艺术大屏与产品首屏交互中。",
    tags: ["TypeScript", "WebGL 2.0", "GPU Physics", "Vite"],
    url: "#",
    stats: { stars: 1240, forks: 89, impact: "60 FPS @ 100k particles" },
    featured: true,
    role: "Creator & Lead Designer",
    year: "2025"
  },
  {
    id: "aurora-editor",
    title: "Aurora Neomorphic Markdown Editor",
    description: "全手写无外部依赖的渐变流光渲染 Markdown 编辑器，支持流畅的块级拖拽与深度可视化排版。",
    longDescription: "Aurora 是一款极富未来主义美学的 Markdown 实时排版与笔记工具。编辑体验基于块级原子化架构（Block-based Architecture），完全重写了光标和选区事件。配备自研的流光代码块高亮器和 LaTeX 公式实时渐变渲染。专为写作者提供零干扰、沉浸式、极具呼吸感的微交互写作空间。",
    tags: ["React 19", "Tailwind CSS", "Lexical Core", "Motion"],
    url: "#",
    stats: { stars: 945, forks: 42, impact: "25k+ Active Writers" },
    featured: true,
    role: "Architect & Motion Designer",
    year: "2024"
  },
  {
    id: "visio-grid",
    title: "VisioGrid Collaborative Canvas",
    description: "具有无限画布的端到端实时协同设计工具，集成矢量节点计算、碰撞反馈与多人在画布上的完美对齐。",
    longDescription: "VisioGrid 是一个高度自由的无限画布协同工具，用于思维脑图与系统原型设计。采用极简扁平的矢量渲染架构，支持毫秒级的碰撞反馈与吸附算法。利用 WebSocket 达成毫秒级数据同步，具备高弹性的撤销重做（Undo/Redo）历史记录合并机制，给设计师和工程师带来行云流水般的对齐创作感受。",
    tags: ["TypeScript", "HTML5 Canvas", "WebSocket", "Conflict-Free State"],
    url: "#",
    stats: { stars: 720, forks: 65, impact: "Realtime Sync < 15ms" },
    featured: false,
    role: "Core Contributor",
    year: "2024"
  }
];

export const BLOG_POSTS: BlogPost[] = [
  {
    id: "micro-interactions",
    title: "微交互的艺术：如何在极简界面中用动效创造“触感”",
    excerpt: "完美的动效不应当是引人注目的噪音，而是界面的呼吸。本文探讨物理弹性、贝塞尔曲线、微弱的反弹，以及如何用数学公式模拟现实世界的触感物理机制。",
    content: `在极简主义的设计哲学中，“少即是多”是黄金法则。然而，许多设计师在追求视觉极简时，往往不小心剥离了界面与用户之间的情感链接，使应用变得冰冷、死板。

如何解决这个问题？答案是 **微交互（Micro-interactions）**。

微交互就像物理世界的摩擦力、惯性和阻尼。一个按钮在被按下时，不应该只是简单地改变背景颜色，它应当像一块有弹性的橡胶，或者一个真实的金属薄片——轻微下陷、在释放时带着微弱的惯性回弹。

### 1. 物理弹性的数学之美

在网页动画中，我们最常用的是贝塞尔曲线（Cubic-bezier），但贝塞尔曲线在表达复杂的物理振荡（如弹簧）时显得力不从心。这也就是为什么优秀的交互设计师会使用基于弹簧物理方程的动效：

$$F = -kx - cv$$

其中，$k$ 是弹簧刚度（stiffness），$c$ 是阻尼系数（damping），$x$ 是位移，$v$ 是速度。

在 React 中，利用 \`motion\` (Framer Motion) 可以非常优雅地定义这种弹性：

\`\`\`typescript
<motion.button
  whileHover={{ scale: 1.03 }}
  whileTap={{ scale: 0.97 }}
  transition={{
    type: "spring",
    stiffness: 400,
    damping: 15
  }}
>
  点击感知弹性
</motion.button>
\`\`\`

### 2. 交互的四个触感层次

在我们的实际开发中，我们把触感交互分为四个阶段：
1. **预备感知（Affordance）**：当鼠标移近目标（Hover）时，目标通过微弱的位移或局部发光，给鼠标施加一个“无形的引力场”。
2. **操作反馈（Action）**：按下（Press）时，卡片整体向后压下，且阴影收缩，暗示深度感。
3. **惯性释放（Release）**：鼠标抬起或滑出，元素像琴弦般轻微颤动，恢复原状。
4. **状态残留（Lingering）**：操作成功后，局部元素（如勾选框）带起一圈极其精细的粒子飞溅或流光溢彩。

### 3. 性能第一：动效不是性能的敌人

炫技的同时绝不能牺牲帧率。动画必须遵循以下原则：
- **只触发 GPU 渲染**：只对 \`transform\` (scale, translate, rotate) 和 \`opacity\` 做动画，严禁在动画中频繁更改 \`width\`、\`height\`、\`margin\` 等会触发浏览器重排（Reflow）的属性。
- **动态帧率调配**：对于高密度的视觉反馈（如粒子网格），在没有交互时应当降低渲染循环的执行频率，在鼠标靠近时再瞬间唤醒至满帧 60fps/120fps。

当一个极简的白色背景上，仅仅因为你光标的一次划过，而荡漾开一圈极其轻柔、符合物理特性的波纹，这种惊喜感是无可比拟的。这就是我们在前端炫技中真正追求的交互艺术。`,
    date: "2026-06-15",
    readTime: "7 min read",
    category: "Design System",
    tags: ["Motion", "UI/UX", "Web Physics", "Typography"],
    views: 4850,
    likes: 312,
    status: "published"
  },
  {
    id: "webgl-particles-intro",
    title: "打破DOM的局限：用 WebGL 2.0 在网页端操控十万粒子",
    excerpt: "当 DOM 无法承载成千上万个元素的实时物理计算时，我们应该如何利用 GPU 的强大并行能力？本文带你一览 Canvas Shader 粒子渲染及物理模拟算法实现。",
    content: `前端界面的终点不止于 DOM 节点。当你要渲染一万个、十万个独立粒子，并让它们根据鼠标的引力和排斥力实时移动时，常规的 DOM 元素甚至普通的 2D Canvas 上下文都会瞬间卡死。

这时候，我们需要请出浏览器底层的超级引擎：**WebGL 2.0**。

### 1. 为什么 DOM 会卡死？

DOM（文档对象模型）在设计之初是为了承载结构化的文本和多媒体内容。每个 DOM 节点都带着极其厚重的内存开销（包括样式计算、布局、图层合并、事件监听器等）。
而 WebGL 则是直接与操作系统的显卡驱动进行对话。在 WebGL 中，没有所谓的“标签”或“卡片”，有的只是顶点（Vertices）、像素着色器（Fragment Shaders）和在内存中流动的浮点数数组。

### 2. GPU 物理模拟的核心思路：在着色器中运行算法

在传统的 CPU 渲染中，我们通过 \`requestAnimationFrame\` 循环，遍历一个包含十万个 JavaScript 对象的数组，在每一次循环中计算它们的新坐标：

\`\`\`javascript
// ❌ 传统做法：在 CPU 中循环计算，十万粒子会导致极大的主线程阻塞
particles.forEach(p => {
  p.x += p.vx;
  p.y += p.vy;
});
\`\`\`

而高效的 WebGL 做法，是将粒子所有的初始坐标、速度、加速度打包成二进制缓冲区（VBO - Vertex Buffer Object），一次性灌入 GPU 的显存中。
接着，通过 **Vertex Shader（顶点着色器）** 直接在 GPU 核心中并行计算每个粒子的新位置。如果一块显卡有 2048 个着色内核，那它就能同时计算 2048 个粒子的位置，计算效率将获得成百上千倍的提升。

### 3. 着色器代码极简窥探

以下是实现“鼠标排斥力”的顶点着色器伪代码：

\`\`\`glsl
#version 300 es
in vec2 a_position;
in vec2 a_velocity;
uniform vec2 u_mouse;
uniform float u_time;
out vec4 v_color;

void main() {
    vec2 pos = a_position;
    // 计算粒子到鼠标的距离
    float dist = distance(pos, u_mouse);
    if (dist < 0.2) {
        // 计算排斥力向量
        vec2 dir = normalize(pos - u_mouse);
        float force = (0.2 - dist) * 1.5;
        pos += dir * force;
    }
    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = 2.0;
}
\`\`\`

### 4. 极致视觉的克制表达

在极简风格的网站中，千万不要把粒子背景做得花哨繁杂。最优雅的呈现应当是：
1. **单色微调**：粒子颜色与背景色保持极近的层次关系。例如背景是 \`#0a0a0a\`，粒子可以设计为半透明的 \`rgba(255,255,255, 0.08)\`，只有在鼠标靠近时，它才亮起为 \`rgba(255,255,255, 0.35)\`。
2. **隐藏连线**：仅在粒子相距极近时绘制一条细如发丝的半透明连线，呈现出如同神经元网格或宇宙尘埃般的隐约质感。

这种在克制中藏着磅礴力量的设计，正是高端工程师最爱展示的“低调的前端炫技”。`,
    date: "2026-05-28",
    readTime: "12 min read",
    category: "WebGL",
    tags: ["WebGL", "GPU Physics", "Performance", "Canvas"],
    views: 6100,
    likes: 423,
    status: "published"
  },
  {
    id: "css-layouts-evolution",
    title: "现代 CSS 排版美学：重力、韵律与响应式栅格",
    excerpt: "跳出繁复的UI库，用最少、最干净的 CSS 构建会跳动、有呼吸感的网格版式。讨论 CSS Subgrid, Container Queries 以及不对称比例。",
    content: `一个网站给人的第一眼高级感，往往来自于它的**版式和负空间（Negative Space）**。

在中文排版与极简英文的混排中，如何不依赖厚重的 UI 框架，纯粹用原生 CSS 表现出宛如实体杂志般的奢华质感与空气感？

### 1. 黄金负空间的分配比例

很多人以为“极简”就是空无一物，于是把边距调得极大。然而，无序的空旷只会让人感到空洞和结构混乱。
高级的极简网站应该使用非对称的、动态变化的网格。例如：
- 采用 **1:2 的非对称黄金两栏布局**（比如左侧 33% 承载固定视窗的个人简介与定位线，右侧 66% 承载可以无限滚动的流式作品集）。
- 利用 CSS \`clamp()\` 函数定义无极变速的字体大小与内边距，让网站在 13寸 M3 MacBook Air 和 32寸 4K 护眼屏上均能完美呼吸：

\`\`\`css
.hero-title {
  font-size: clamp(2rem, 5vw + 1rem, 5.5rem);
  line-height: 1.05;
  letter-spacing: -0.03em;
}
\`\`\`

### 2. 认识 CSS Subgrid：子网格对齐的救星

在过去，如果我们有多张卡片，每张卡片里包含标题、描述和页脚，要想让邻近卡片的标题和页脚在垂直方向上实现完美的、像素级的一致对齐，通常需要写死高度或者使用复杂的 JS 计算。

而现在，\`grid-template-rows: subgrid\` 彻底解决了这个问题：

\`\`\`css
.card-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  grid-template-rows: auto auto auto; /* 外部定义行高 */
}

.card-item {
  grid-row: span 3; /* 跨越三行 */
  display: grid;
  grid-template-rows: subgrid; /* 深度继承并锁定外部行高 */
}
\`\`\`

通过 subgrid，哪怕两张卡片的文本长短不一，它们内部对应的标题和按钮也会雷打不动地排在同一条视平线上。这种细节处的“强迫症式的严丝合缝”，是奠定版面精致感的基础。

### 3. Container Queries：组件容器查询的突破

以往我们用 \`@media (max-width: 768px)\` 是根据**整个浏览器窗口**的宽度来改变布局。但在现代模块化架构中，一个卡片组件放在侧边栏和放在主内容区时，它的物理宽度是截然不同的。

借助 **容器查询（Container Queries）**，我们可以让卡片根据**它自身所在的父容器宽度**来改变形态：

\`\`\`css
.parent-container {
  container-type: inline-size;
  container-name: card-slot;
}

@container card-slot (max-width: 400px) {
  .card-item {
    flex-direction: column;
    padding: 1rem;
  }
}
\`\`\`

这使得卡片在任何栅格卡槽中都能弹性自愈、自动适配，大幅减少了在顶层写全局媒体查询的维护心智。

用最精简、最现代的原生 CSS，将排版雕琢至每一个像素，这本身就是一场关于优雅与性能的无声宣言。`,
    date: "2026-04-10",
    readTime: "8 min read",
    category: "CSS",
    tags: ["CSS Subgrid", "Layout Design", "Responsive", "Web Standards"],
    views: 3410,
    likes: 198,
    status: "published"
  }
];
