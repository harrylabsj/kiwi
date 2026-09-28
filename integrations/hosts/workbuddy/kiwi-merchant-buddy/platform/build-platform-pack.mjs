#!/usr/bin/env node
/**
 * WP18：从 buddy-app.config.json（1.7.0）生成 WorkBuddy 开放平台可导入的配置包。
 *
 * 输出（默认写到本目录 out/）：
 *   - industry-config.json：平台「导入配置」用（格式为项目经理从平台前端 importer 反推的
 *     近似格式，见 docs 项目推进-一键上云/30-平台配置模型发现.md；权威以实际导入结果为准）
 *   - icons/*.svg：模式 4 个 + 胶囊 20 个，线性图标、单色 #16A34A、48×48 viewBox、
 *     无文字、无外部引用、单文件 <4KB，文件名与 JSON 的 iconFileName 一致
 *
 * 平台校验规则（前端常量，全部内置为本脚本校验，不通过即失败）：
 *   工作模式 3–5 个；每模式 ≥5 个胶囊且每个胶囊只能属于一个模式；
 *   模式/胶囊名称 ≤5 个汉字、英文名 ≤30；每胶囊 4–10 条提示词模板；
 *   模式 systemPrompt 必填；不存在按胶囊绑定工具（bindTools/bindSkills 不可导入，
 *   工具/技能指引改写进胶囊 systemPromptAppend）；inspirationIds 不用即不填；
 *   图标 SVG ≥48×48，模式必填。
 *
 * 用法：node integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs [--out DIR]
 */
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(scriptDir, "../buddy-app.config.json");
const DEFAULT_OUT_DIR = path.resolve(scriptDir, "out");

// 平台模板版本未知，先按 1.0.0，导入失败按平台报错调整（WP18 任务书约定）。
const PLATFORM_TEMPLATE_VERSION = "1.0.0";
// templateId 留空：导入时平台按应用 ID（cb_jU2kgRjXVRjE2gmSjgyH）校验，不一致会报 idMismatch。
const PLATFORM_TEMPLATE_ID = "";
// 已撤回的 v1.1.0 连接器资产，任何输出不得引用。
const WITHDRAWN_CONNECTOR_ID = "oc_c86216e2a36110bf";
// 平台技能资产 ID：目前只有 cs-prep 有先例 ID（见 buddy-app.config.json $pending.skills）；
// kiwi-cloud-deploy / kiwi-product-import 审核通过后由项目经理回填并重新生成。
const SKILL_ASSET_IDS = {
  "kiwi-merchant-cs-prep": "os_dc3a52407574eb77",
};

const ICON_STROKE = "#16A34A";
const svgWrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="${ICON_STROKE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// 统一风格：线性图标、单色 #16A34A、48×48、无文字、无外部引用。
const ICONS = {
  // 工作模式（4）
  "mode-onboarding.svg": svgWrap(
    '<path d="M24 6c4 4 6 9 6 14v8H18v-8c0-5 2-10 6-14z"/><circle cx="24" cy="18" r="3"/><path d="M18 34l-5 8M30 34l5 8M24 34v8"/>',
  ),
  "mode-operations.svg": svgWrap(
    '<rect x="12" y="8" width="24" height="32" rx="3"/><path d="M19 8V5h10v3"/><path d="M18 20h12M18 27h12M18 34h7"/>',
  ),
  "mode-visibility.svg": svgWrap(
    '<path d="M6 38l12-12 8 8 14-16"/><path d="M28 18h12v12"/>',
  ),
  "mode-cs-prep.svg": svgWrap(
    '<path d="M10 30v-8a14 14 0 0 1 28 0v8"/><rect x="6" y="26" width="8" height="14" rx="3"/><rect x="34" y="26" width="8" height="14" rx="3"/>',
  ),
  // 注册开通（5）
  "cap-register.svg": svgWrap(
    '<circle cx="20" cy="16" r="7"/><path d="M8 38c0-7 5-11 12-11s12 4 12 11"/><path d="M35 6v12M29 12h12"/>',
  ),
  "cap-connect.svg": svgWrap(
    '<path d="M20 28l8-8"/><path d="M14 22l-4 4a8 8 0 0 0 11 11l4-4"/><path d="M34 26l4-4a8 8 0 0 0-11-11l-4 4"/>',
  ),
  "cap-golive.svg": svgWrap(
    '<circle cx="24" cy="16" r="3"/><path d="M17 23a10 10 0 0 1 14 0M12 28a17 17 0 0 1 24 0"/><path d="M24 16v25M18 41h12"/>',
  ),
  "cap-email.svg": svgWrap(
    '<rect x="6" y="10" width="36" height="28" rx="3"/><path d="M8 13l16 12 16-12"/>',
  ),
  "cap-cloud.svg": svgWrap(
    '<path d="M12 28a7 7 0 0 1 2-14 11 11 0 0 1 21 3 7 7 0 0 1 1 11z"/><path d="M24 40V28M19 33l5-5 5 5"/>',
  ),
  // 日常运营（5）
  "cap-products.svg": svgWrap(
    '<rect x="8" y="10" width="32" height="28" rx="3"/><path d="M8 19h32M8 28h32M21 19v19"/>',
  ),
  "cap-rules.svg": svgWrap(
    '<path d="M8 16h32M8 32h32"/><circle cx="19" cy="16" r="5"/><circle cx="30" cy="32" r="5"/>',
  ),
  "cap-slots.svg": svgWrap(
    '<rect x="8" y="8" width="13" height="13" rx="2"/><rect x="27" y="8" width="13" height="13" rx="2"/><rect x="8" y="27" width="13" height="13" rx="2"/><path d="M33.5 27v13M27 33.5h13"/>',
  ),
  "cap-approvals.svg": svgWrap(
    '<path d="M11 14l3 3 5-6M11 26l3 3 5-6M11 38l3 3 5-6"/><path d="M25 15h13M25 27h13M25 39h13"/>',
  ),
  "cap-reception.svg": svgWrap(
    '<path d="M8 18a24 24 0 0 1 32 0M13 25a16 16 0 0 1 22 0"/><circle cx="24" cy="33" r="3"/>',
  ),
  // 曝光优化（5）
  "cap-views.svg": svgWrap(
    '<path d="M4 24c5-8 11-12 20-12s15 4 20 12c-5 8-11 12-20 12S9 32 4 24z"/><circle cx="24" cy="24" r="5"/>',
  ),
  "cap-followers.svg": svgWrap(
    '<circle cx="18" cy="16" r="7"/><path d="M6 38c0-7 5-11 12-11 3 0 5 .7 7 2"/><circle cx="32" cy="19" r="5"/><path d="M30 38c0-6 4-9 9-9 4 0 7 2 8 6"/>',
  ),
  "cap-copy.svg": svgWrap(
    '<path d="M32 8l8 8L18 38l-10 2 2-10z"/><path d="M28 12l8 8"/>',
  ),
  "cap-search.svg": svgWrap('<circle cx="21" cy="21" r="13"/><path d="M31 31l9 9"/>'),
  "cap-audit.svg": svgWrap(
    '<path d="M24 5l15 5v12c0 10-6 16-15 21-9-5-15-11-15-21V10z"/><path d="M17 24l5 5 9-10"/>',
  ),
  // 客服准备（5）
  "cap-faq.svg": svgWrap(
    '<path d="M8 10h32v22H22l-8 8v-8H8z"/><path d="M20 17a4 4 0 1 1 6 3.4c-1.6 1-2 1.8-2 3.3"/><circle cx="24" cy="27.5" r="1.2" fill="#16A34A" stroke="none"/>',
  ),
  "cap-scripts.svg": svgWrap(
    '<path d="M10 6h20l8 8v28H10z"/><path d="M30 6v8h8"/><path d="M17 24h14M17 31h9"/>',
  ),
  "cap-mock.svg": svgWrap(
    '<path d="M6 6h24v16H16l-6 6v-6H6z"/><path d="M42 24v14h-4v5l-6-5H20v-8h10v-6h12z"/>',
  ),
  "cap-escalate.svg": svgWrap(
    '<circle cx="16" cy="14" r="7"/><path d="M4 38c0-7 5-12 12-12 2.8 0 5.3.8 7.3 2.2"/><path d="M28 38L40 26M40 26h-9M40 26v9"/>',
  ),
  "cap-reply-check.svg": svgWrap(
    '<path d="M6 10h30v18H20l-7 7v-7H6z"/><path d="M14 19l4 4 8-9"/>',
  ),
};

/**
 * 平台包内容映射表。约定：
 * - modeKey 对应 buddy-app.config.json 的 home.modes[].key；模式名/系统提示词/skills 均从源配置读取，
 *   保证「以 buddy-app.config.json 为唯一内容源」不漂移。
 * - sourceCapsules 必须是该模式在 1.7.0 中的真实胶囊 label（脚本校验）；本地草稿「一个胶囊 = 一句
 *   提示词」，平台要求「胶囊 = 场景 + 4–10 条模板」，因此按主题合并/扩写。
 * - systemPromptAppend 把原 bindTools/bindSkills 的「该用哪个工具/技能」改写为文字指引（平台不存在
 *   按胶囊绑定工具）；其中提到的工具/技能必须出现在源模式的 tools/skills 里（脚本校验）。
 * - 模板第一句尽量沿用 1.7.0 胶囊原文；不得承诺免费/7×24、不得编造数据。
 */
const MODE_PACKS = [
  {
    modeKey: "onboarding",
    titleEn: "Onboarding",
    icon: "mode-onboarding.svg",
    scenes: [
      {
        id: "cap-register",
        title: "注册账号",
        titleEn: "Sign up",
        icon: "cap-register.svg",
        sourceCapsules: ["注册账号", "已有账号"],
        systemPromptAppend:
          "先判断商家处于开通哪一步：优先用 kiwi_catalog_get_service_status 读取开通状态；该工具不可用时改用 kiwi_catalog_get_merchant_profile 判断账号是否已连接。按阶段只讲下一步要做的一件事，不一次倒出全部流程。",
        templates: [
          {
            title: "新商家注册",
            titleEn: "New merchant sign-up",
            prompt: "我还没有 Kiwi 商家账号，帮我注册开通",
            promptEn: "I don't have a Kiwi merchant account yet. Help me sign up.",
          },
          {
            title: "已有账号连接",
            titleEn: "Connect existing account",
            prompt: "我已经有 Kiwi 商家账号，帮我连接",
            promptEn: "I already have a Kiwi merchant account. Help me connect it.",
          },
          {
            title: "了解开通步骤",
            titleEn: "What are the steps",
            prompt: "开通一共几步？我现在到哪一步了？",
            promptEn: "How many steps does onboarding take? Which step am I on?",
          },
          {
            title: "注册前问题",
            titleEn: "Questions before signing up",
            prompt: "注册 Kiwi 商家账号需要准备什么信息？",
            promptEn: "What information do I need to prepare to sign up for a Kiwi merchant account?",
          },
        ],
      },
      {
        id: "cap-connect",
        title: "连接发布",
        titleEn: "Connect & Publish",
        icon: "cap-connect.svg",
        sourceCapsules: ["连接发布"],
        systemPromptAppend:
          "配对码显示在本应用的商家工作台；用 kiwi_catalog_get_service_status 确认连接与发布状态后，再引导商家打开 Catalog 授权页，核对两处配对码一致、公开预览无误，由商家亲自点击「连接此服务并发布」。配对码和链接都不是授权凭证，提醒商家不要外发；你不读取、不转述配对码。",
        templates: [
          {
            title: "找配对码",
            titleEn: "Where is the pairing code",
            prompt: "配对码在哪里看？怎么确认「连接此服务并发布」？",
            promptEn:
              "Where can I find the pairing code? How do I confirm \"Connect and publish\"?",
          },
          {
            title: "核对配对码",
            titleEn: "Verify the pairing code",
            prompt: "工作台和授权页的配对码不一致，怎么办？",
            promptEn:
              "The pairing codes shown in the workbench and the authorization page don't match. What should I do?",
          },
          {
            title: "发布须知",
            titleEn: "Before publishing",
            prompt: "点「连接此服务并发布」之前我要核对什么？",
            promptEn: "What should I check before clicking \"Connect and publish\"?",
          },
          {
            title: "配对码安全",
            titleEn: "Keep the code safe",
            prompt: "配对码可以告诉别人吗？",
            promptEn: "Is it safe to share my pairing code with others?",
          },
        ],
      },
      {
        id: "cap-golive",
        title: "上线检查",
        titleEn: "Go-live Check",
        icon: "cap-golive.svg",
        sourceCapsules: ["上线检查"],
        systemPromptAppend:
          "只有 kiwi_catalog_get_service_status 显示名片已发布且在线状态正常时，才能说「已上线，采购方可以发现你并发来询价」；否则如实说明卡在哪一步和下一步动作，不确定就说不确定。",
        templates: [
          {
            title: "是否已上线",
            titleEn: "Am I live",
            prompt: "我开通好了吗？采购方现在能找到我吗？",
            promptEn: "Is my setup complete? Can buyers find me now?",
          },
          {
            title: "卡在哪步",
            titleEn: "Where am I stuck",
            prompt: "我卡在开通流程里了，帮我看卡在哪一步、下一步做什么",
            promptEn:
              "I'm stuck in onboarding. Help me see which step is blocking and what to do next.",
          },
          {
            title: "名片状态",
            titleEn: "Card status",
            prompt: "我的商家名片发布了吗？",
            promptEn: "Has my merchant card been published?",
          },
          {
            title: "上线后效果",
            titleEn: "What happens next",
            prompt: "上线之后采购方会怎么联系我？",
            promptEn: "How will buyers reach me once I'm live?",
          },
        ],
      },
      {
        id: "cap-email",
        title: "邮箱验证",
        titleEn: "Email Verification",
        icon: "cap-email.svg",
        sourceCapsules: ["邮箱验证"],
        systemPromptAppend:
          "用 kiwi_catalog_get_merchant_profile 判断账号是否已连接；验证邮箱后连接失效属正常情况，引导重新发起连接即可。",
        templates: [
          {
            title: "没收到邮件",
            titleEn: "Didn't get the email",
            prompt: "验证邮件没收到，或者验证完回不到应用，怎么办？",
            promptEn:
              "I didn't receive the verification email, or I couldn't get back to the app after verifying. What should I do?",
          },
          {
            title: "重发验证",
            titleEn: "Resend the email",
            prompt: "可以重新发一封验证邮件吗？",
            promptEn: "Can you resend the verification email?",
          },
          {
            title: "换邮箱",
            titleEn: "Change email",
            prompt: "我填错邮箱了，还能改吗？",
            promptEn: "I entered the wrong email address. Can I change it?",
          },
          {
            title: "连接失效",
            titleEn: "Connection expired",
            prompt: "验证完邮箱后连接失效了，要重新连接吗？",
            promptEn: "The connection expired after I verified my email. Do I need to reconnect?",
          },
        ],
      },
      {
        id: "cap-cloud",
        title: "一键上云",
        titleEn: "One-click Cloud",
        icon: "cap-cloud.svg",
        sourceCapsules: ["一键开通云端接待", "升级接待服务"],
        systemPromptAppend:
          "云端接待的开通与升级都按 kiwi-cloud-deploy 技能执行：开通前先确认商家已连接 Kiwi 账号（kiwi_catalog_get_merchant_profile）；严格按 inspect→activate→取包校验→prepare→deploy→自检→引导确认的顺序，不跳步、不伪造回执；部署失败时把平台报错原样贴给商家，不修改部署包重试；会话缺少云发布工具时改输出技能内置的方案 B 提示词并说明。",
        templates: [
          {
            title: "开通云端接待",
            titleEn: "Launch cloud reception",
            prompt: "帮我把云端接待服务一键开通上线，我再到 Catalog 上确认发布",
            promptEn:
              "Launch my cloud reception service in one click. I'll confirm the publication on Catalog afterwards.",
          },
          {
            title: "升级版本",
            titleEn: "Upgrade the service",
            prompt: "有新版本了，帮我升级云端接待服务",
            promptEn: "There's a new version. Help me upgrade my cloud reception service.",
          },
          {
            title: "部署前确认",
            titleEn: "Before deploying",
            prompt: "一键上云前我需要准备或确认什么？",
            promptEn: "What do I need to prepare or confirm before one-click cloud deployment?",
          },
          {
            title: "部署失败",
            titleEn: "Deployment failed",
            prompt: "部署报错了，把报错原样贴给我，帮我下一步怎么做",
            promptEn: "Deployment failed. Show me the error as-is and tell me what to do next.",
          },
        ],
      },
    ],
  },
  {
    modeKey: "operations",
    titleEn: "Daily Operations",
    icon: "mode-operations.svg",
    scenes: [
      {
        id: "cap-products",
        title: "整理商品",
        titleEn: "Product Prep",
        icon: "cap-products.svg",
        sourceCapsules: ["整理商品"],
        systemPromptAppend:
          "按 kiwi-product-import 技能执行：先与商家逐列确认映射，生成与工作台「商品与导入」页可下载的 CSV/Excel 模板完全一致的文件，并附问题清单；列名不确定时请商家下载模板或提供列名，不要自创。绝不编造价格/库存/规格/有效期，缺失标「需商家补充」；疑似底价/成本/进价列一律剔除；每次提醒整表替换语义——表里没有的 SKU 提交后会被下架，首次导入建议小批量试；上传与确认导入由商家本人在工作台完成。",
        templates: [
          {
            title: "整理成导入表",
            titleEn: "Build an import sheet",
            prompt: "帮我把商品整理成可以导入工作台的表格",
            promptEn: "Help me organize my products into a sheet I can import into the workbench.",
          },
          {
            title: "拿到模板",
            titleEn: "Get the template",
            prompt: "工作台的导入模板长什么样？到哪里下载？",
            promptEn: "What does the workbench import template look like? Where can I download it?",
          },
          {
            title: "列名映射",
            titleEn: "Map my columns",
            prompt: "我的商品资料列名和模板不一样，帮我逐列对上",
            promptEn:
              "My product sheet's column names differ from the template. Help me map them one by one.",
          },
          {
            title: "首次导入建议",
            titleEn: "First import tips",
            prompt: "第一次导入商品要注意什么？",
            promptEn: "What should I pay attention to when importing products for the first time?",
          },
        ],
      },
      {
        id: "cap-rules",
        title: "报价规则",
        titleEn: "Quote Rules",
        icon: "cap-rules.svg",
        sourceCapsules: ["报价规则"],
        templates: [
          {
            title: "定报价规则",
            titleEn: "Set quote rules",
            prompt: "帮我定报价规则：哪些可以自动报价，哪些要我审批",
            promptEn:
              "Help me set quote rules: which inquiries can be auto-quoted and which need my approval.",
          },
          {
            title: "底价与口径",
            titleEn: "Floors and terms",
            prompt: "帮我起草底价、起订量和交期的口径",
            promptEn: "Help me draft how to state floor prices, MOQ and delivery times.",
          },
          {
            title: "审批边界",
            titleEn: "Approval boundary",
            prompt: "什么样的询价必须转人工审批？",
            promptEn: "What kinds of inquiries must go to human approval?",
          },
          {
            title: "规则草稿检查",
            titleEn: "Review my draft",
            prompt: "我起草的报价规则帮我检查有没有漏洞",
            promptEn: "Review my draft quote rules and point out any gaps.",
          },
        ],
      },
      {
        id: "cap-slots",
        title: "商品名额",
        titleEn: "Listing Slots",
        icon: "cap-slots.svg",
        sourceCapsules: ["商品名额", "腾出名额"],
        systemPromptAppend:
          "用 kiwi_catalog_get_service_status 读取商品名额（已用/总数）与服务在线状态；名额满时说明需先下架商品释放名额，或联系 Kiwi 调整额度，不承诺付费扩容。",
        templates: [
          {
            title: "剩余名额",
            titleEn: "Slots left",
            prompt: "我还能上架几个商品？",
            promptEn: "How many more products can I list?",
          },
          {
            title: "名额满了",
            titleEn: "Slots are full",
            prompt: "商品名额满了，怎么下架商品腾出名额？",
            promptEn: "My listing slots are full. How do I delist products to free up space?",
          },
          {
            title: "名额政策",
            titleEn: "Slot policy",
            prompt: "商品名额是怎么算的？",
            promptEn: "How are listing slots counted?",
          },
          {
            title: "需要更多名额",
            titleEn: "Need more slots",
            prompt: "名额不够用了，我有哪些选择？",
            promptEn: "I'm running out of slots. What are my options?",
          },
        ],
      },
      {
        id: "cap-approvals",
        title: "待审批",
        titleEn: "Approvals",
        icon: "cap-approvals.svg",
        sourceCapsules: ["待审批"],
        templates: [
          {
            title: "有无待办",
            titleEn: "Any pending items",
            prompt: "有采购方询价在等我处理吗？在哪里审批？",
            promptEn: "Are there buyer inquiries waiting for me? Where do I approve them?",
          },
          {
            title: "审批流程",
            titleEn: "How approval works",
            prompt: "待审批的询价怎么处理？",
            promptEn: "How do I handle pending inquiries?",
          },
          {
            title: "对话与审批",
            titleEn: "Chat vs approval",
            prompt: "在对话里说「同意」算批准吗？",
            promptEn: "Does saying \"agree\" in this chat count as an approval?",
          },
          {
            title: "提醒规则",
            titleEn: "Stay on top",
            prompt: "怎样不漏掉要审批的询价？",
            promptEn: "How do I make sure I don't miss inquiries that need approval?",
          },
        ],
      },
      {
        id: "cap-reception",
        title: "接待状态",
        titleEn: "Service Status",
        icon: "cap-reception.svg",
        sourceCapsules: ["接待状态"],
        systemPromptAppend:
          "用 kiwi_catalog_get_service_status 读取服务在线状态并如实转述；不承诺在线时长，休眠/重启等情况如实说明。",
        templates: [
          {
            title: "是否在线",
            titleEn: "Am I online",
            prompt: "我的接待服务现在在线吗？",
            promptEn: "Is my reception service online right now?",
          },
          {
            title: "最近状态",
            titleEn: "Recent status",
            prompt: "帮我看看我的接待服务最近状态",
            promptEn: "Check the recent status of my reception service.",
          },
          {
            title: "离线原因",
            titleEn: "Why offline",
            prompt: "接待服务不在线了，可能是什么原因？",
            promptEn: "My reception service is offline. What could be the reason?",
          },
          {
            title: "恢复方法",
            titleEn: "How to recover",
            prompt: "接待服务离线后怎么恢复？",
            promptEn: "How do I bring my reception service back online?",
          },
        ],
      },
    ],
  },
  {
    modeKey: "visibility",
    titleEn: "Visibility",
    icon: "mode-visibility.svg",
    scenes: [
      {
        id: "cap-views",
        title: "浏览数据",
        titleEn: "Views",
        icon: "cap-views.svg",
        sourceCapsules: ["浏览数据", "冷热对比"],
        systemPromptAppend:
          "用 kiwi_catalog_get_merchant_stats 读经营汇总；该汇总是匿名聚合：只有关注人数和浏览量，没有关注者身份、名单或联系方式，也没有群发通道——如实说明，不承诺触达或导出。",
        templates: [
          {
            title: "最近浏览",
            titleEn: "Recent views",
            prompt: "我的公开资料最近有多少人看？",
            promptEn: "How many people have viewed my public profile recently?",
          },
          {
            title: "冷热对比",
            titleEn: "Hot vs cold",
            prompt: "哪条资料看的人最多，哪条没人看？",
            promptEn: "Which listing gets the most views, and which gets none?",
          },
          {
            title: "浏览变化",
            titleEn: "View trends",
            prompt: "帮我看看浏览量有什么变化",
            promptEn: "Help me understand how my views have changed.",
          },
          {
            title: "数据口径",
            titleEn: "What the data covers",
            prompt: "浏览数据能看到哪些信息？",
            promptEn: "What information do the view stats cover?",
          },
        ],
      },
      {
        id: "cap-followers",
        title: "关注人数",
        titleEn: "Followers",
        icon: "cap-followers.svg",
        sourceCapsules: ["关注人数"],
        systemPromptAppend:
          "用 kiwi_catalog_get_merchant_stats 读关注人数；汇总是匿名聚合，没有关注者名单或联系方式，也没有群发通道——如实说明，不承诺触达或导出。",
        templates: [
          {
            title: "有多少关注",
            titleEn: "How many followers",
            prompt: "现在有多少采购方在关注我的店铺？",
            promptEn: "How many buyers are following my store now?",
          },
          {
            title: "关注变化",
            titleEn: "Follower trends",
            prompt: "帮我看看关注人数的变化",
            promptEn: "Show me how my follower count has changed.",
          },
          {
            title: "关注者是谁",
            titleEn: "Who follows me",
            prompt: "我能看到关注我的人是谁吗？",
            promptEn: "Can I see who is following me?",
          },
          {
            title: "触达关注者",
            titleEn: "Reach followers",
            prompt: "我能给关注我的采购方发消息吗？",
            promptEn: "Can I message the buyers who follow me?",
          },
        ],
      },
      {
        id: "cap-copy",
        title: "优化文案",
        titleEn: "Copywriting",
        icon: "cap-copy.svg",
        sourceCapsules: ["优化文案"],
        systemPromptAppend:
          "改文案前先用 kiwi_catalog_get_publication 逐条读取当前内容，不凭记忆重写；改好后用 kiwi_catalog_save_publication_draft 存草稿；需要生效时用 kiwi_catalog_request_publish，并明确告诉商家「尚未发布，需要你到门户核对预览并确认」，撤回用 kiwi_catalog_withdraw_publication。",
        templates: [
          {
            title: "改资料文案",
            titleEn: "Improve my copy",
            prompt: "帮我把资料文案改好，让采购专家更容易搜到",
            promptEn: "Improve my listing copy so procurement experts can find me more easily.",
          },
          {
            title: "只改一条",
            titleEn: "One listing at a time",
            prompt: "先帮我优化这一条资料的标题和简介",
            promptEn: "Optimize the title and description of this one listing first.",
          },
          {
            title: "卖点提炼",
            titleEn: "Highlight selling points",
            prompt: "帮我把这条商品的可公开卖点写清楚",
            promptEn: "Help me state the public selling points of this product clearly.",
          },
          {
            title: "存草稿",
            titleEn: "Save as draft",
            prompt: "改好的文案先存草稿，发布我再到门户确认",
            promptEn: "Save the improved copy as a draft first. I'll confirm publication myself.",
          },
        ],
      },
      {
        id: "cap-search",
        title: "搜索词",
        titleEn: "Search Terms",
        icon: "cap-search.svg",
        sourceCapsules: ["搜索词检查"],
        systemPromptAppend:
          "用 kiwi_catalog_get_publication 逐条读取当前标题与类目再检查，不凭记忆重写。",
        templates: [
          {
            title: "检查标题",
            titleEn: "Check my titles",
            prompt: "采购方会用哪些词搜我这类商品？帮我检查标题",
            promptEn: "Which terms would buyers use to search for my kind of products? Check my titles.",
          },
          {
            title: "选关键词",
            titleEn: "Pick keywords",
            prompt: "帮我给这几条商品挑更常被搜索的词",
            promptEn: "Help me pick more commonly searched terms for these listings.",
          },
          {
            title: "类目是否准确",
            titleEn: "Category check",
            prompt: "我的商品类目填得准吗？",
            promptEn: "Are my product categories accurate?",
          },
          {
            title: "标题改法",
            titleEn: "Title rewrite",
            prompt: "按采购方的搜索习惯帮我把这条标题改一版",
            promptEn: "Rewrite this title the way buyers would search for it.",
          },
        ],
      },
      {
        id: "cap-audit",
        title: "资料体检",
        titleEn: "Profile Audit",
        icon: "cap-audit.svg",
        sourceCapsules: ["资料体检"],
        systemPromptAppend:
          "用 kiwi_catalog_get_publication 逐条读取当前内容，用 kiwi_catalog_get_merchant_stats 读浏览与关注数据，对照检查缺项；不确定的标「需商家补充」。",
        templates: [
          {
            title: "全面体检",
            titleEn: "Full check",
            prompt: "帮我检查公开资料有没有缺项或写得不清楚的地方",
            promptEn: "Check my public profile for missing or unclear parts.",
          },
          {
            title: "逐条检查",
            titleEn: "Listing-by-listing",
            prompt: "帮我逐条过一遍在架资料的完整性",
            promptEn: "Go through my live listings one by one for completeness.",
          },
          {
            title: "缺什么信息",
            titleEn: "What's missing",
            prompt: "我的资料里缺哪些采购方关心的信息？",
            promptEn: "What buyer-relevant information is missing from my listings?",
          },
          {
            title: "体检后改进",
            titleEn: "Fix the findings",
            prompt: "按体检结果帮我把资料补齐",
            promptEn: "Help me fill the gaps found in the audit.",
          },
        ],
      },
    ],
  },
  {
    modeKey: "cs-prep",
    titleEn: "CS Prep",
    icon: "mode-cs-prep.svg",
    scenes: [
      {
        id: "cap-faq",
        title: "整理问答",
        titleEn: "FAQ Prep",
        icon: "cap-faq.svg",
        sourceCapsules: ["整理问答"],
        templates: [
          {
            title: "整理成问答",
            titleEn: "Turn notes into FAQ",
            prompt: "我把商品说明贴给你，帮我整理成客服问答",
            promptEn: "I'll paste my product notes. Turn them into a customer-service FAQ.",
          },
          {
            title: "精简问答",
            titleEn: "Trim the FAQ",
            prompt: "帮我把这份问答精简成 10 条以内",
            promptEn: "Trim this FAQ down to 10 entries or fewer.",
          },
          {
            title: "补问句",
            titleEn: "Add buyer questions",
            prompt: "按这份资料再补几个采购方可能问的问题",
            promptEn: "Based on this material, add more questions buyers might ask.",
          },
          {
            title: "标注依据",
            titleEn: "Cite sources",
            prompt: "每条问答都标注信息来自哪里，没有依据的单独列出",
            promptEn: "Mark the source of each Q&A entry, and list unsupported ones separately.",
          },
        ],
      },
      {
        id: "cap-scripts",
        title: "售后话术",
        titleEn: "Aftersales Scripts",
        icon: "cap-scripts.svg",
        sourceCapsules: ["售后话术"],
        templates: [
          {
            title: "起草回复",
            titleEn: "Draft replies",
            prompt: "根据我的售后政策，起草常见问题的回复",
            promptEn: "Draft replies to common questions based on my aftersales policy.",
          },
          {
            title: "退货话术",
            titleEn: "Returns",
            prompt: "帮我起草退货和换货场景的回复草稿",
            promptEn: "Draft reply scripts for returns and exchanges.",
          },
          {
            title: "交期话术",
            titleEn: "Delivery times",
            prompt: "采购方催交期，帮我起草得体的回复",
            promptEn: "A buyer is pushing on delivery time. Draft a proper reply.",
          },
          {
            title: "政策缺口",
            titleEn: "Policy gaps",
            prompt: "我的售后政策里哪些没写清楚？帮我列出来",
            promptEn: "Which parts of my aftersales policy are unclear? List them for me.",
          },
        ],
      },
      {
        id: "cap-mock",
        title: "模拟提问",
        titleEn: "Mock Questions",
        icon: "cap-mock.svg",
        sourceCapsules: ["模拟提问"],
        templates: [
          {
            title: "常问十题",
            titleEn: "Ten common questions",
            prompt: "模拟采购方最常问的 10 个问题，并准备回复草稿",
            promptEn: "Simulate the 10 questions buyers ask most, and prepare draft replies.",
          },
          {
            title: "刁钻问题",
            titleEn: "Hard questions",
            prompt: "模拟几个难回答的采购方问题，帮我准备应对",
            promptEn: "Simulate a few tough buyer questions and help me prepare answers.",
          },
          {
            title: "价格追问",
            titleEn: "Price pressure",
            prompt: "模拟采购方压价的对话，帮我准备回应草稿",
            promptEn: "Simulate a buyer pushing for lower prices and draft my responses.",
          },
          {
            title: "逐条标注",
            titleEn: "Tag each reply",
            prompt: "模拟提问的每条回复都标注处理方式（可答/澄清/转人工）",
            promptEn:
              "Tag each simulated reply with how to handle it: answerable, needs clarification, or escalate.",
          },
        ],
      },
      {
        id: "cap-escalate",
        title: "转人工",
        titleEn: "Escalation",
        icon: "cap-escalate.svg",
        sourceCapsules: ["转人工清单"],
        templates: [
          {
            title: "转人工清单",
            titleEn: "Escalation list",
            prompt: "哪些问题必须转人工处理？帮我列个清单",
            promptEn: "Which issues must be escalated to a human? Make me a list.",
          },
          {
            title: "转接话术",
            titleEn: "Handoff script",
            prompt: "帮我起草转人工时对采购方说的话术",
            promptEn: "Draft what to say to a buyer when escalating to a human.",
          },
          {
            title: "判断标准",
            titleEn: "When to escalate",
            prompt: "怎么判断一个问题要不要转人工？",
            promptEn: "How do I decide whether a question should be escalated?",
          },
          {
            title: "边界问题",
            titleEn: "Boundary cases",
            prompt: "涉及价格让步和合同条款的问题怎么处理？",
            promptEn: "How should questions involving price concessions or contract terms be handled?",
          },
        ],
      },
      {
        id: "cap-reply-check",
        title: "回复检查",
        titleEn: "Reply Check",
        icon: "cap-reply-check.svg",
        sourceCapsules: ["回复检查"],
        templates: [
          {
            title: "能否直接用",
            titleEn: "Ready to send",
            prompt: "这条回复能直接对外用吗？帮我看看",
            promptEn: "Can this reply be sent as-is? Take a look.",
          },
          {
            title: "检查依据",
            titleEn: "Check the sources",
            prompt: "帮我检查这条回复里有没有没有依据的说法",
            promptEn: "Check whether this reply contains any unsupported claims.",
          },
          {
            title: "语气润色",
            titleEn: "Polish the tone",
            prompt: "帮我把这条回复的语气改得更得体",
            promptEn: "Polish the tone of this reply.",
          },
          {
            title: "改进建议",
            titleEn: "Suggest improvements",
            prompt: "这条回复哪里容易让采购方误会？帮我指出",
            promptEn: "Which parts of this reply might confuse a buyer? Point them out.",
          },
        ],
      },
    ],
  },
];

// 模板文本禁词：平台口径不得承诺免费/7×24、不得编造数据（1.7.0 边界）。
// 英文只禁承诺性短语，避免误伤 "free up space" 这类动词用法。
const TEMPLATE_BANNED_PATTERNS = [
  /免费/,
  /7×24/,
  /7x24/i,
  /全天候/,
  /\bfor free\b/i,
  /\bfree of charge\b/i,
  /\bfree plan\b/i,
];

const TOOL_NAME_RE = /\b(kiwi_[a-z0-9_]+)\b/g;
const SKILL_NAME_RE = /\b(kiwi-(?:cloud-deploy|product-import|merchant-cs-prep))\b/g;

export { CONFIG_PATH, DEFAULT_OUT_DIR, ICONS, MODE_PACKS, SKILL_ASSET_IDS };

function readConfig(configPath = CONFIG_PATH) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.version !== "1.7.0") {
    throw new Error(`buddy-app.config.json 版本应为 1.7.0，实际 ${config.version}`);
  }
  return config;
}

function extractConnectorId(config) {
  const connectorNote = String(config.home["内置连接器"] ?? "");
  // 说明文本会同时提到已撤回资产（「不得再引用」），先剔除再要求恰好一个在用 ID。
  const ids = [...connectorNote.matchAll(/oc_[0-9a-f]{8,}/g)]
    .map((m) => m[0])
    .filter((id) => id !== WITHDRAWN_CONNECTOR_ID);
  const unique = [...new Set(ids)];
  if (unique.length !== 1) {
    throw new Error(`内置连接器说明中应恰好包含一个在用 oc_ 资产 ID，实际：${unique.join(", ") || "无"}`);
  }
  return unique[0];
}

/** 生成平台配置包；校验失败时抛出 Error（逐条列出）。 */
export function buildPlatformPack(config) {
  const connectorId = extractConnectorId(config);
  const sourceModes = new Map(config.home.modes.map((m) => [m.key, m]));
  const warnings = [];
  let templateSeq = 0;

  const modeItems = MODE_PACKS.map((pack) => {
    const sourceMode = sourceModes.get(pack.modeKey);
    if (!sourceMode) throw new Error(`映射表引用了配置中不存在的工作模式 ${pack.modeKey}`);
    const skills = (sourceMode.skills ?? [])
      .map((skill) => {
        const assetId = SKILL_ASSET_IDS[skill];
        if (!assetId) {
          warnings.push(
            `模式 ${sourceMode.name} 的技能 ${skill} 尚无平台资产 ID，导入包中省略；审核通过后回填 SKILL_ASSET_IDS 并重新生成。`,
          );
        }
        return assetId ? { id: assetId } : null;
      })
      .filter(Boolean);

    const scenes = pack.scenes.map((scene) => {
      const item = {
        id: scene.id,
        title: scene.title,
        titleEn: scene.titleEn,
        iconFileName: scene.icon,
      };
      if (scene.systemPromptAppend) item.systemPromptAppend = scene.systemPromptAppend;
      item.templates = scene.templates.map((t) => ({
        id: `t${++templateSeq}`,
        title: t.title,
        titleEn: t.titleEn,
        prompt: t.prompt,
        promptEn: t.promptEn,
      }));
      return item;
    });

    return {
      modeId: pack.modeKey,
      title: sourceMode.name,
      titleEn: pack.titleEn,
      iconFileName: pack.icon,
      systemPromptAppend: sourceMode.systemPrompt,
      skills,
      scenes,
    };
  });

  const industryConfig = {
    templateId: PLATFORM_TEMPLATE_ID,
    version: PLATFORM_TEMPLATE_VERSION,
    ui: {
      nav: {
        items: [
          {
            id: "home",
            target: "builtin:new_task",
            title: "conversation.newTask",
            order: 10,
            config: {
              header: {
                visible: true,
                // 品牌名与标语在平台上的分隔方式未知：留空，由项目经理在界面填
                // 「Kiwi商家 / 让采购专家找到你」（buddy-app.config.json home.title）。
                title: "",
              },
              modes: {
                defaultSelected: MODE_PACKS[0].modeKey,
                items: modeItems,
              },
            },
          },
        ],
      },
      chatInput: { placeholder: config.misc["输入框占位符"].zh },
    },
    // 模板 title/prompt 直接使用中文文案并内嵌 promptEn，不依赖 i18n key，故英文源留空。
    i18n: { source: { en: {} } },
    // 1.7.0 misc.模型配置：以 WorkBuddy 模型池为主，不引用 Kiwi 本地模型。
    models: { custom: { disabled: true } },
    jointAuth: { connectorName: connectorId },
    authConfig: {
      mcpOnly: true,
      skipJump: config.misc["跳过首次绑定应用授权"],
      capabilityDescription: config.misc["绑定应用授权文案"],
    },
  };

  const errors = validatePlatformPack(industryConfig, config, sourceModes);
  if (errors.length > 0) {
    throw new Error(`平台配置包校验失败（${errors.length} 项）：\n- ${errors.join("\n- ")}`);
  }
  return { industryConfig, icons: ICONS, warnings };
}

function validateSvg(name, svg) {
  const errors = [];
  if (!svg.startsWith("<svg ") || !svg.endsWith("</svg>")) {
    errors.push(`${name}: 不是以 <svg> 开始/结束的完整 SVG 文档`);
  }
  if (!svg.includes('viewBox="0 0 48 48"')) {
    errors.push(`${name}: 缺少 48×48 viewBox`);
  }
  const lower = svg.toLowerCase();
  const banned = ["<script", "<text", "<image", "<foreignobject", "href=", "xlink:", "url(", "<use", "data:", "javascript:", "@import"];
  for (const token of banned) {
    if (lower.includes(token)) errors.push(`${name}: 含禁止内容 ${token}`);
  }
  // 标签配对粗检（全部子标签要求自闭合或与闭合标签匹配；属性区贪婪匹配会吞掉
  // 自闭合斜杠，故以属性区是否以 "/" 结尾判定自闭合）。
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  for (const m of svg.matchAll(tagRe)) {
    const closing = m[1] === "/";
    const tag = m[2];
    const attrs = m[3];
    if (closing) {
      const top = stack.pop();
      if (top !== tag) errors.push(`${name}: 标签配对错误（</${tag}> 对应 <${top ?? "无"}>）`);
    } else if (!/\/\s*$/.test(attrs)) {
      stack.push(tag);
    }
  }
  if (stack.length > 0) errors.push(`${name}: 有未闭合标签 ${stack.join(", ")}`);
  const bytes = Buffer.byteLength(svg, "utf8");
  if (bytes >= 4096) errors.push(`${name}: ${bytes} 字节 ≥ 4KB`);
  return errors;
}

function validatePlatformPack(industryConfig, config, sourceModes) {
  const errors = [];
  const homeItem = industryConfig.ui.nav.items[0];
  const modeItems = homeItem.config.modes.items;

  // 图标全集校验（无论是否被引用）。
  for (const [name, svg] of Object.entries(ICONS)) {
    errors.push(...validateSvg(name, svg));
  }

  // 平台规则：模式 3–5 个。
  if (modeItems.length < 3 || modeItems.length > 5) {
    errors.push(`工作模式数量应为 3–5，实际 ${modeItems.length}`);
  }

  const zhNameRe = /^[\u4e00-\u9fa5]{1,5}$/;
  const seenModeIds = new Set();
  const seenSceneIds = new Set();
  const seenTemplateIds = new Set();
  const coveredSourceCapsules = new Map(); // label -> scene id（校验 1.7.0 胶囊全部被覆盖且不重复归属）

  for (const mode of modeItems) {
    const sourceMode = sourceModes.get(mode.modeId);
    if (!sourceMode) {
      errors.push(`模式 ${mode.modeId} 在源配置中不存在`);
      continue;
    }
    if (seenModeIds.has(mode.modeId)) errors.push(`模式 ID 重复：${mode.modeId}`);
    seenModeIds.add(mode.modeId);

    // 模式名沿用 1.7.0 原名（内容源一致性），且 ≤5 个汉字。
    if (mode.title !== sourceMode.name) {
      errors.push(`模式 ${mode.modeId} 的 title（${mode.title}）与源配置名称（${sourceMode.name}）不一致`);
    }
    if (!zhNameRe.test(mode.title)) errors.push(`模式名「${mode.title}」应为 1–5 个汉字`);
    if ([...mode.titleEn].length > 30) errors.push(`模式英文名超 30 字符：${mode.titleEn}`);
    if (!mode.systemPromptAppend || !mode.systemPromptAppend.trim()) {
      errors.push(`模式 ${mode.modeId} 的 systemPromptAppend 为空（平台必填）`);
    }
    if (!ICONS[mode.iconFileName]) errors.push(`模式 ${mode.modeId} 图标缺失：${mode.iconFileName}`);

    // 平台规则：每模式 ≥5 个胶囊。
    if (mode.scenes.length < 5) {
      errors.push(`模式 ${mode.modeId} 胶囊数应 ≥5，实际 ${mode.scenes.length}`);
    }
    const sourceLabels = new Set(sourceMode.capsules.map((c) => c.label));
    const modeTools = new Set(sourceMode.tools ?? []);
    const modeSkills = new Set(sourceMode.skills ?? []);

    const pack = MODE_PACKS.find((p) => p.modeKey === mode.modeId);
    for (const scene of mode.scenes) {
      const label = `胶囊 ${scene.id}（${scene.title}）`;
      // 每个胶囊只能属于一个模式 ⇔ scene id 全局唯一（scenes 仅在单个模式下定义）。
      if (seenSceneIds.has(scene.id)) errors.push(`${label} ID 重复（跨模式重复归属）`);
      seenSceneIds.add(scene.id);
      if (!zhNameRe.test(scene.title)) errors.push(`${label} 名称「${scene.title}」应为 1–5 个汉字`);
      if ([...scene.titleEn].length > 30) errors.push(`${label} 英文名超 30 字符：${scene.titleEn}`);
      if (!ICONS[scene.iconFileName]) errors.push(`${label} 图标缺失：${scene.iconFileName}`);
      if (scene.systemPromptAppend !== undefined && !scene.systemPromptAppend.trim()) {
        errors.push(`${label} systemPromptAppend 存在但为空`);
      }

      // 平台规则：每胶囊 4–10 条提示词模板。
      if (scene.templates.length < 4 || scene.templates.length > 10) {
        errors.push(`${label} 模板数应为 4–10，实际 ${scene.templates.length}`);
      }
      for (const t of scene.templates) {
        if (seenTemplateIds.has(t.id)) errors.push(`模板 ID 重复：${t.id}`);
        seenTemplateIds.add(t.id);
        for (const field of ["title", "titleEn", "prompt", "promptEn"]) {
          if (!t[field] || !t[field].trim()) errors.push(`模板 ${t.id} 的 ${field} 为空`);
        }
        if ([...t.title].length > 12) errors.push(`模板 ${t.id} 标题过长：${t.title}`);
        if ([...t.titleEn].length > 30) errors.push(`模板 ${t.id} 英文标题超 30 字符：${t.titleEn}`);
        const text = `${t.title}\n${t.titleEn}\n${t.prompt}\n${t.promptEn}`;
        for (const pattern of TEMPLATE_BANNED_PATTERNS) {
          if (pattern.test(text)) errors.push(`模板 ${t.id} 含禁词（${pattern}）：${text.replace(/\n/g, " ")}`);
        }
      }

      // 内容源锚定：sourceCapsules 必须是源模式真实胶囊；且工具/技能指引不超出源模式授权范围。
      const sceneDef = pack?.scenes.find((s) => s.id === scene.id);
      if (!sceneDef) {
        errors.push(`${label} 在映射表中无定义`);
        continue;
      }
      for (const sourceLabel of sceneDef.sourceCapsules) {
        if (!sourceLabels.has(sourceLabel)) {
          errors.push(`${label} 的 sourceCapsules 引用了 ${mode.modeId} 模式下不存在的胶囊「${sourceLabel}」`);
        }
        if (coveredSourceCapsules.has(sourceLabel)) {
          errors.push(`源胶囊「${sourceLabel}」被 ${coveredSourceCapsules.get(sourceLabel)} 与 ${scene.id} 重复覆盖`);
        }
        coveredSourceCapsules.set(sourceLabel, scene.id);
      }
      const append = scene.systemPromptAppend ?? "";
      for (const m of append.matchAll(TOOL_NAME_RE)) {
        if (!modeTools.has(m[1])) errors.push(`${label} 的 systemPromptAppend 引用了模式 ${mode.modeId} 工具列表外的工具 ${m[1]}`);
      }
      for (const m of append.matchAll(SKILL_NAME_RE)) {
        if (!modeSkills.has(m[1])) errors.push(`${label} 的 systemPromptAppend 引用了模式 ${mode.modeId} 技能列表外的技能 ${m[1]}`);
      }
    }

    // 1.7.0 的胶囊一个不漏（合并进平台胶囊，不丢失场景）。
    for (const capsule of sourceMode.capsules) {
      if (!coveredSourceCapsules.has(capsule.label)) {
        errors.push(`1.7.0 胶囊「${capsule.label}」（${mode.modeId}）未被任何平台胶囊覆盖`);
      }
    }
  }

  // inspirationIds 不用即不填；平台不存在按胶囊绑定工具/技能（任意层级出现即失败）。
  const bannedKeys = new Set(["bindTools", "bindSkills", "inspirationIds"]);
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${trail}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (bannedKeys.has(key)) errors.push(`输出 ${trail} 包含平台不可导入的键 ${key}`);
        walk(value, `${trail}.${key}`);
      }
    }
  };
  walk(industryConfig, "$");
  const serialized = JSON.stringify(industryConfig);
  if (serialized.includes(WITHDRAWN_CONNECTOR_ID)) {
    errors.push(`输出引用了已撤回的连接器资产 ${WITHDRAWN_CONNECTOR_ID}`);
  }

  // 与 1.7.0 一致性：占位符 / 授权文案 / 连接器。
  if (industryConfig.ui.chatInput.placeholder !== config.misc["输入框占位符"].zh) {
    errors.push("chatInput.placeholder 与 1.7.0 misc.输入框占位符.zh 不一致");
  }
  if (industryConfig.authConfig.capabilityDescription !== config.misc["绑定应用授权文案"]) {
    errors.push("authConfig.capabilityDescription 与 1.7.0 misc.绑定应用授权文案 不一致");
  }
  if ([...industryConfig.authConfig.capabilityDescription].length > 30) {
    errors.push("authConfig.capabilityDescription 超 30 字（平台上限）");
  }
  if (!/^oc_[0-9a-f]{8,}$/.test(industryConfig.jointAuth.connectorName)) {
    errors.push(`jointAuth.connectorName 不是合法连接器资产 ID：${industryConfig.jointAuth.connectorName}`);
  }

  // 图标字典与 JSON 引用一一对应，无多余。
  const referenced = new Set(
    modeItems.flatMap((m) => [m.iconFileName, ...m.scenes.map((s) => s.iconFileName)]),
  );
  for (const name of referenced) {
    if (!ICONS[name]) errors.push(`JSON 引用的图标不存在：${name}`);
  }
  for (const name of Object.keys(ICONS)) {
    if (!referenced.has(name)) errors.push(`图标 ${name} 未被 JSON 引用（多余文件）`);
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const outDirIdx = args.indexOf("--out");
  const outDir = outDirIdx >= 0 ? path.resolve(args[outDirIdx + 1]) : DEFAULT_OUT_DIR;

  const config = readConfig();
  const { industryConfig, icons, warnings } = buildPlatformPack(config);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "icons"), { recursive: true });
  writeFileSync(path.join(outDir, "industry-config.json"), `${JSON.stringify(industryConfig, null, 2)}\n`);
  for (const [name, svg] of Object.entries(icons)) {
    writeFileSync(path.join(outDir, "icons", name), `${svg}\n`);
  }

  const modes = industryConfig.ui.nav.items[0].config.modes.items;
  const sceneCount = modes.reduce((sum, m) => sum + m.scenes.length, 0);
  const templateCount = modes.reduce((sum, m) => sum + m.scenes.reduce((s, sc) => s + sc.templates.length, 0), 0);
  console.log(`平台配置包已生成：${outDir}`);
  console.log(`- industry-config.json：模板 ${modes.length} 个模式 / ${sceneCount} 个胶囊 / ${templateCount} 条模板`);
  console.log(`- icons/：${Object.keys(icons).length} 个 SVG（模式 ${modes.length} + 胶囊 ${sceneCount}）`);
  console.log(`- jointAuth.connectorName = ${industryConfig.jointAuth.connectorName}；defaultSelected = ${industryConfig.ui.nav.items[0].config.modes.defaultSelected}`);
  if (warnings.length > 0) {
    console.warn("警告：");
    for (const w of warnings) console.warn(`- ${w}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
