// Simple FNV-1a hash function to convert a seed string to a 32-bit unsigned integer
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiply by FNV prime (16777619)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

// 1. Topic pools across diverse categories (cleaned up to start with nouns or gerunds for natural phrasing)
const TOPICS = {
  technology: [
    "the virtual DOM in modern frontend frameworks",
    "SQL vs NoSQL database choice for microservices",
    "Tailwind CSS pros and cons compared to vanilla CSS",
    "Docker containers vs traditional virtual machines",
    "how HTTPS encryption protects user data",
    "REST APIs vs GraphQL performance and design",
    "optimizing web apps to reduce render-blocking resources",
    "implementing clean architecture in software projects",
    "how AI-powered calendar tools can improve productivity",
    "the Page Visibility API in modern browsers",
    "serverless architecture advantages and cost implications",
    "edge computing and how it reduces latency",
    "WebSocket protocol for real-time bidirectional communication",
    "how modern compilers optimize Javascript execution",
    "the role of reverse proxies like Nginx or Cloudflare in web hosting",
    "database indexing strategies for slow search queries",
    "how OAuth 2.0 authorization code flow works under the hood",
    "semantic HTML and why it is critical for screen readers",
    "using CSS Grid vs Flexbox for complex layout patterns",
    "micro-frontends architecture pros and cons for large engineering teams",
    "micro-frontends vs monorepos in scalable architectures",
    "how garbage collection works in Java vs V8 Javascript engine",
    "the difference between TCP and UDP protocols with examples",
    "implementing rate limiting algorithms like Token Bucket in APIs",
    "how Redis caching improves read-heavy database performance",
    "the role of WebAssembly in bringing desktop apps to the browser",
    "implementing secure session cookies vs local storage for JWT tokens",
    "how GraphQL resolvers work under the hood",
    "the difference between symmetrical and asymmetrical encryption simply explained",
    "using Server-Sent Events (SSE) vs WebSockets for real-time notifications",
    "optimizing SQL queries by analyzing EXPLAIN query plans",
    "how DNS propagation works when changing name servers",
    "the core principles of Git version control internal storage model",
    "how Content Delivery Networks (CDNs) cache static assets globally",
    "the difference between CPU-bound and I/O-bound tasks in Node.js"
  ],
  creative: [
    "a quiet morning in the foggy mountains",
    "a time traveler who gets stuck in Paris during the 1920s",
    "an AI coding assistant becoming overly dramatic",
    "a detective solving a mystery in a futuristic cyberpunk city",
    "a conversation between a philosopher and a smart home speaker",
    "a fantasy world where magic is treated like programming code",
    "the feeling of exploring an abandoned library in the middle of a forest",
    "a coffee shop owner who discovers they can read minds but only about coffee orders",
    "the last library on Earth operating on a satellite",
    "two trees who have watched a city grow around them for 200 years",
    "a dragon who is afraid of fire and prefers baking",
    "a submariner crew encountering a mysterious ancient vault at the bottom of the Mariana Trench",
    "a chef who opens a restaurant serving memories instead of food",
    "an old grandfather clock that controls the speed of time in a house",
    "a stray cat who secretly runs a neighborhood library for mice",
    "a writer who discovers that whatever they write on an old typewriter comes true",
    "a futuristic city where citizens trade emotions like currency",
    "a lighthouse keeper who guides ships between parallel universes",
    "a painting of a doorway that occasionally opens into a real garden",
    "a musician who plays a melody that makes people forget their worries",
    "a gardener who grows flowers that bloom with the sound of music",
    "a message in a bottle found on a dry desert dune"
  ],
  lifestyle: [
    "finding highly-rated non-touristy restaurants or cafes in Tokyo",
    "preparing 3 quick, healthy, and delicious dinner recipes under 20 minutes",
    "training for a 5K race from scratch",
    "planning weekend road trips within 3 hours of San Francisco",
    "improving public presentation skills for tech conferences",
    "designing a minimalist and highly productive home office setup",
    "growing organic herbs on a small balcony",
    "finding top outdoor hiking and camping destinations in the Pacific Northwest",
    "practicing simple mindfulness techniques to reduce daily screen fatigue",
    "choosing coffee brewing methods and how they affect taste profile",
    "building a sustainable capsule wardrobe on a budget",
    "meal prepping for busy remote developers",
    "learning a new language in 15 minutes a day",
    "doing a 10-minute morning stretching routine for office workers to relieve stiffness",
    "meal planning to reduce food waste and save budget",
    "maintaining long-distance friendships while working remotely",
    "caring for indoor house plants that require minimal sunlight and care",
    "organizing a digital clutter clean-up for your computer and phone",
    "understanding the health benefits of drinking loose leaf green tea daily",
    "journaling for mental clarity and goal tracking",
    "building a basic travel packing list for light-weight carry-on travel",
    "falling asleep naturally without screens"
  ],
  business: [
    "writing a polite feedback-request email to a project manager",
    "drafting a concise response to a client wanting to decrease budget",
    "writing a professional cover letter for a Senior Software Engineer position",
    "negotiating a freelance contract with a startup",
    "outlining a pitch deck for a new mobile application idea",
    "onboarding remote team members and building trust",
    "running an effective sprint retrospective in agile development",
    "preparing and presenting annual budget reviews",
    "resolving a communication bottleneck between product managers and engineering teams",
    "negotiating a salary increase during a performance review",
    "writing a brief project proposal for cross-departmental approval",
    "delegating tasks as a newly promoted manager",
    "handling a difficult conversation with an underperforming team member",
    "crafting an elevator pitch for a software-as-a-service (SaaS) product",
    "staying focused during long virtual meetings",
    "organizing and categorizing project requirements using user stories",
    "managing cap tables and equity shares in a startup",
    "reviewing pull requests constructively as a lead developer",
    "calculating customer acquisition cost (CAC) and lifetime value (LTV)"
  ],
  learning: [
    "the difference between deep learning and traditional machine learning",
    "the main ideas behind Stoic philosophy and workplace stress management",
    "the difference between declarative and imperative programming styles",
    "how DNS resolution works step-by-step from browser to server",
    "key cognitive biases that affect software developers and managers",
    "the history of the Gutenberg printing press and its impact on society",
    "how quantum computing works using an analogy a high schooler would understand",
    "the economic concept of opportunity cost and how to apply it to daily choices",
    "how the human brain forms new habits according to modern neuroscience",
    "the history of cryptography from Caesar cipher to modern RSA key pairs",
    "basic principles of financial planning and compound interest explained simply",
    "the science of sleep and how blue light affects sleep cycles",
    "the main differences between classical mechanics and quantum mechanics",
    "how the human immune system remembers past infections",
    "the history of the Silk Road and how it shaped trade routes",
    "the difference between inflation and deflation in economics",
    "how the water cycle works and the role of forests in rainfall",
    "how the printing press changed education in Europe",
    "the basic rules of playing chess for beginners",
    "how solar panels convert sunlight into electricity",
    "the origins of the solar system and how planets formed",
    "the difference between deductive and inductive reasoning"
  ]
};

const TOPICS_VI = {
  technology: [
    "sự khác biệt giữa Virtual DOM và Real DOM trong React",
    "cách lựa chọn cơ sở dữ liệu SQL và NoSQL cho hệ thống microservices",
    "ưu và nhược điểm của Tailwind CSS so với CSS thuần",
    "sự khác biệt giữa Docker container và máy ảo truyền thống VM",
    "cách giao thức HTTPS mã hóa và bảo vệ dữ liệu người dùng",
    "hiệu năng và thiết kế của REST API so với GraphQL",
    "cách tối ưu hóa trang web để giảm tài nguyên chặn hiển thị",
    "áp dụng kiến trúc sạch Clean Architecture vào dự án phần mềm",
    "công cụ quản lý lịch hẹn bằng AI giúp tăng năng suất làm việc",
    "tầm quan trọng của Page Visibility API trong lập trình web hiện đại"
  ],
  creative: [
    "một buổi sáng bình yên đầy sương mù trên đỉnh núi Đà Lạt",
    "một người du hành thời gian bị kẹt lại Hà Nội những năm 1930",
    "một trợ lý AI viết code bỗng dưng sướt mướt",
    "một thám tử tư giải quyết vụ án mạng kỳ bí trong thành phố tương lai cyberpunk",
    "cuộc đối thoại triết học giữa một nhà hiền triết và chiếc loa thông minh trong nhà",
    "một thế giới giả tưởng nơi phép thuật được vận hành như mã nguồn lập trình"
  ],
  lifestyle: [
    "tìm các quán cà phê yên tĩnh, thích hợp làm việc tại trung tâm Sài Gòn",
    "nấu 3 món ăn tối dinh dưỡng, dễ làm dưới 20 phút",
    "lên lộ trình tập luyện 4 tuần để chạy được 5km cho người mới bắt đầu",
    "khám phá các địa điểm cắm trại cuối tuần tuyệt đẹp cách Hà Nội dưới 3 tiếng di chuyển",
    "cải thiện kỹ năng thuyết trình trước đám đông cho lập trình viên",
    "thiết kế góc làm việc tại nhà tối giản và tạo cảm hứng",
    "trồng rau sạch và thảo mộc ngoài ban công chung cư"
  ],
  business: [
    "viết email lịch sự gửi quản lý để xin đánh giá hiệu quả công việc",
    "viết phản hồi chuyên nghiệp khi khách hàng đột ngột đòi giảm ngân sách",
    "viết thư xin việc chuyên nghiệp ứng tuyển vị trí Kỹ sư Phần mềm Cao cấp",
    "đàm phán hợp đồng freelance với một công ty startup công nghệ",
    "lập dàn ý bài thuyết trình Pitch Deck kêu gọi vốn cho một ứng dụng di động mới",
    "onboarding nhân sự làm việc từ xa hiệu quả",
    "tổ chức một buổi họp cải tiến Sprint Retrospective hiệu quả trong Agile"
  ]
};

// Formatting constraints or follow-ups to diversify output structure
const FORMATS = [
  "Use bullet points for key takeaways.",
  "Keep the tone professional and warm.",
  "Use a friendly, casual, conversational tone.",
  "Include a short summary at the end.",
  "Give clear step-by-step instructions.",
  "Explain with a simple real-world analogy.",
  "Keep it concise and straight to the point.",
  "Provide a couple of realistic examples.",
  "Organize with clear subheadings."
];

const FORMATS_VI = [
  "Hãy sử dụng các gạch đầu dòng cho các ý chính.",
  "Giữ giọng văn chuyên nghiệp nhưng ấm áp.",
  "Hãy dùng giọng điệu thân thiện, tự nhiên như trò chuyện.",
  "Thêm một phần tóm tắt ngắn gọn ở cuối câu trả lời.",
  "Đưa ra hướng dẫn từng bước rõ ràng.",
  "Giải thích bằng một ví dụ ẩn dụ thực tế dễ hình dung.",
  "Hãy viết thật ngắn gọn, súc tích và đi thẳng vào vấn đề.",
  "Cung cấp một vài ví dụ thực tế cụ thể.",
  "Trình bày bố cục rõ ràng với các tiêu đề phụ."
];

// Combinatorial components to construct millions of completely unique, natural phrasing structures
const GREETINGS = ["", "", "", "Hi,", "Hello,", "Hey there,", "Hey,", "Quick question:", "Just wondering:"];
const GREETINGS_VI = ["", "", "", "Chào bạn,", "Hi,", "Cho mình hỏi chút:", "Mình muốn hỏi:", "Bạn ơi,"];

const STYLES = ["", "", "", "in simple terms", "for a beginner", "with real-world examples", "without getting too technical", "simply explained"];
const STYLES_VI = ["", "", "", "bằng ngôn từ đơn giản nhất", "cho người mới bắt đầu", "kèm ví dụ thực tế", "tránh dùng quá nhiều thuật ngữ chuyên môn", "một cách dễ hiểu nhất"];

// Contexts (Referential) - used in Phrasing Pattern 1
const CONTEXTS = {
  technology: [
    "I'm currently working on a project involving {topic}.",
    "I'm trying to improve my understanding of {topic}.",
    "I've been reading about {topic} recently.",
    "I am studying {topic} for an upcoming test or interview.",
    "I want to get a better grasp of {topic}."
  ],
  learning: [
    "I'm currently trying to learn about {topic}.",
    "I've been reading up on {topic} lately.",
    "I want to get a better grasp of {topic}.",
    "I'm preparing for a discussion about {topic}."
  ],
  business: [
    "I want to get better at {topic}.",
    "I'm looking for some practical advice on {topic}.",
    "I need to handle {topic} for my work.",
    "I'm currently trying to figure out {topic}."
  ],
  lifestyle: [
    "I want to get better at {topic}.",
    "I'm looking for some practical tips on {topic}.",
    "I need to coordinate {topic} for my personal routine.",
    "I'm currently looking into {topic}."
  ],
  creative: [
    "I'm looking for some creative writing inspiration involving {topic}.",
    "I'm trying to draft a narrative scene featuring {topic}.",
    "I'm brainstorming some story ideas centered around {topic}.",
    "I need a creative writing piece about {topic}."
  ]
};

const CONTEXTS_VI = {
  technology: [
    "Mình đang làm một dự án liên quan đến {topic}.",
    "Mình đang cố gắng hiểu rõ hơn về {topic}.",
    "Gần đây mình có tìm đọc tài liệu về {topic}.",
    "Mình đang ôn tập về {topic} để chuẩn bị phỏng vấn."
  ],
  learning: [
    "Mình đang muốn tìm hiểu thêm về {topic}.",
    "Dạo này mình đang đọc và tìm hiểu về {topic}.",
    "Mình muốn nắm vững bản chất của {topic}."
  ],
  business: [
    "Mình muốn cải thiện hiệu quả trong việc {topic}.",
    "Mình đang tìm kiếm một số lời khuyên thực tế về việc {topic}.",
    "Mình cần xử lý tốt việc {topic} trong công việc hàng ngày."
  ],
  lifestyle: [
    "Mình đang muốn lên kế hoạch cho việc {topic}.",
    "Mình muốn bắt đầu học cách {topic}.",
    "Gần đây mình đang quan tâm đến việc {topic}."
  ],
  creative: [
    "Mình đang tìm nguồn cảm hứng sáng tác xoay quanh {topic}.",
    "Mình muốn viết một kịch bản ngắn mô phỏng {topic}.",
    "Mình đang bí ý tưởng cho một câu chuyện về {topic}."
  ]
};

// Referential Actions - used in Phrasing Pattern 1
const ACTIONS_REF = {
  technology: [
    "Can you explain how it works{style}?",
    "Could you write a detailed breakdown of it{style}?",
    "What is the best way to understand the core concepts{style}?",
    "Can you give me a clear and simple overview of how it works{style}?",
    "What are the key differences and pros/cons regarding this?"
  ],
  learning: [
    "Can you explain how it works{style}?",
    "Could you write a detailed breakdown of this{style}?",
    "What is the best way to understand the core concepts{style}?",
    "Can you give me a clear and simple overview of it{style}?"
  ],
  business: [
    "Can you give me a step-by-step guide on how to approach it{style}?",
    "Could you write a simple guide or draft for this?",
    "What are some best practices or recommendations for it?",
    "How can I handle this effectively?"
  ],
  lifestyle: [
    "Can you give me a step-by-step guide on how to approach it{style}?",
    "Could you write a simple guide or draft for this?",
    "What are some best practices or recommendations for it?",
    "How can I get started with this effectively?"
  ],
  creative: [
    "Can you write a short, engaging story about it?",
    "Write a creative and descriptive piece about it.",
    "Could you draft a dialogue or narrative scene depicting this?",
    "Can you write a whimsical or dramatic piece about it?"
  ]
};

const ACTIONS_REF_VI = {
  technology: [
    "Bạn có thể giải thích chi tiết cơ chế hoạt động của nó{style} không?",
    "Bạn có thể viết một bài phân tích sâu về chủ đề này{style} không?",
    "Cách tốt nhất để hiểu và ghi nhớ các khái niệm cốt lõi của nó là gì?",
    "Hãy cho mình một cái nhìn tổng quan ngắn gọn và dễ hiểu nhất về nó."
  ],
  learning: [
    "Bạn có thể giải thích chi tiết cơ chế hoạt động của nó{style} không?",
    "Bạn có thể viết một bài phân tích sâu về chủ đề này{style} không?",
    "Cách tốt nhất để hiểu và ghi nhớ các khái niệm cốt lõi của nó là gì?",
    "Hãy cho mình một cái nhìn tổng quan ngắn gọn và dễ hiểu nhất về nó."
  ],
  business: [
    "Bạn có thể hướng dẫn từng bước cụ thể để thực hiện nó{style} không?",
    "Bạn có thể giúp mình soạn thảo một cẩm nang hoặc bản nháp cho việc này không?",
    "Những kinh nghiệm hoặc best practices cho việc này là gì?",
    "Làm thế nào để bắt đầu việc này một cách hiệu quả nhất?"
  ],
  lifestyle: [
    "Bạn có thể hướng dẫn từng bước cụ thể để thực hiện nó{style} không?",
    "Bạn có thể giúp mình soạn thảo một cẩm nang hoặc bản nháp cho việc này không?",
    "Những kinh nghiệm hoặc best practices cho việc này là gì?",
    "Làm thế nào để bắt đầu việc này một cách hiệu quả nhất?"
  ],
  creative: [
    "Bạn có thể viết một câu chuyện ngắn thú vị về nó không?",
    "Hãy phác họa một tác phẩm tả cảnh sinh động về chủ đề này.",
    "Bạn có thể dựng một đoạn hội thoại hoặc hoạt cảnh về nó không?"
  ]
};

// Direct Actions - used in Phrasing Pattern 2
const ACTIONS_DIRECT = {
  technology: [
    "Can you explain how {topic} works{style}?",
    "Could you write a detailed breakdown of {topic}{style}?",
    "What is the best way to understand the core concepts of {topic}{style}?",
    "Can you give me a clear and simple overview of {topic}{style}?",
    "What are the key differences, pros, and cons regarding {topic}?"
  ],
  learning: [
    "Can you explain how {topic} works{style}?",
    "Could you write a detailed breakdown of {topic}{style}?",
    "What is the best way to understand the core concepts of {topic}{style}?",
    "Can you give me a clear and simple overview of {topic}{style}?"
  ],
  business: [
    "Can you give me a step-by-step guide on how to approach {topic}{style}?",
    "Could you write a simple guide or draft for {topic}?",
    "What are some best practices or recommendations for {topic}?",
    "How can I handle {topic} effectively?"
  ],
  lifestyle: [
    "Can you give me a step-by-step guide on how to approach {topic}{style}?",
    "Could you write a simple guide or draft for {topic}?",
    "What are some best practices or recommendations for {topic}?",
    "How can I get started with {topic} effectively?"
  ],
  creative: [
    "Can you write a short, engaging story about {topic}?",
    "Write a creative and descriptive piece about {topic}.",
    "Could you draft a dialogue or narrative scene depicting {topic}?",
    "Can you write a whimsical or dramatic piece about {topic}?"
  ]
};

const ACTIONS_DIRECT_VI = {
  technology: [
    "Bạn có thể giải thích chi tiết cơ chế hoạt động của {topic}{style} không?",
    "Bạn có thể viết một bài phân tích sâu về {topic}{style} không?",
    "Cách tốt nhất để hiểu và ghi nhớ các khái niệm cốt lõi của {topic} là gì?",
    "Hãy cho mình một cái nhìn tổng quan ngắn gọn và dễ hiểu nhất về {topic}."
  ],
  learning: [
    "Bạn có thể giải thích chi tiết cơ chế hoạt động của {topic}{style} không?",
    "Bạn có thể viết một bài phân tích sâu về {topic}{style} không?",
    "Cách tốt nhất để hiểu và ghi nhớ các khái niệm cốt lõi của {topic} là gì?",
    "Hãy cho mình một cái nhìn tổng quan ngắn gọn và dễ hiểu nhất về {topic}."
  ],
  business: [
    "Bạn có thể hướng dẫn từng bước cụ thể để thực hiện {topic}{style} không?",
    "Bạn có thể giúp mình soạn thảo một cẩm nang hoặc bản nháp cho {topic} không?",
    "Những kinh nghiệm hoặc best practices cho {topic} là gì?",
    "Làm thế nào để thực hiện {topic} một cách hiệu quả nhất?"
  ],
  lifestyle: [
    "Bạn có thể hướng dẫn từng bước cụ thể để thực hiện {topic}{style} không?",
    "Bạn có thể giúp mình soạn thảo một cẩm nang hoặc bản nháp cho {topic} không?",
    "Những kinh nghiệm hoặc best practices cho {topic} là gì?",
    "Làm thế nào để bắt đầu {topic} một cách hiệu quả nhất?"
  ],
  creative: [
    "Bạn có thể viết một câu chuyện ngắn thú vị về {topic} không?",
    "Hãy phác họa một tác phẩm tả cảnh sinh động về {topic}.",
    "Bạn có thể dựng một đoạn hội thoại hoặc hoạt cảnh về {topic} không?"
  ]
};

// Combinatorial Builder to stitch components together naturally
function buildNaturalCombinatorialPrompt(cat, topic, format, hashVal, isVi) {
  const activeGreetings = isVi ? GREETINGS_VI : GREETINGS;
  const activeStyles = isVi ? STYLES_VI : STYLES;
  
  // 1. Choose Greeting (80% chance empty, 20% chosen from list)
  const greetingIdx = (hashVal >>> 1) % (activeGreetings.length * 3);
  const greeting = activeGreetings[greetingIdx] || "";
  
  // 2. Choose Style Modifier (50% chance empty, 50% chosen)
  const styleIdx = (hashVal >>> 2) % (activeStyles.length * 2);
  const rawStyle = activeStyles[styleIdx] || "";
  const style = rawStyle ? (isVi ? ` ${rawStyle}` : ` ${rawStyle}`) : "";
  
  // 3. Choose Phrasing Pattern: 0 = Context + Referential Action, 1 = Direct Action
  const patternType = (hashVal >>> 3) % 2;
  
  let coreSentence = "";
  
  if (patternType === 0) {
    // Pattern 1: Context + Referential Action
    const activeContexts = isVi ? CONTEXTS_VI[cat] : CONTEXTS[cat];
    const activeRefs = isVi ? ACTIONS_REF_VI[cat] : ACTIONS_REF[cat];
    
    if (activeContexts && activeContexts.length > 0 && activeRefs && activeRefs.length > 0) {
      const contextTemplate = activeContexts[(hashVal >>> 4) % activeContexts.length];
      const refActionTemplate = activeRefs[(hashVal >>> 5) % activeRefs.length];
      
      const context = contextTemplate.replace("{topic}", topic);
      const action = refActionTemplate.replace("{style}", style);
      
      coreSentence = `${context} ${action}`;
    } else {
      // Fallback to Direct Action if lists are missing
      const activeDirects = isVi ? ACTIONS_DIRECT_VI[cat] : ACTIONS_DIRECT[cat];
      const directTemplate = activeDirects[(hashVal >>> 4) % activeDirects.length];
      coreSentence = directTemplate.replace("{topic}", topic).replace("{style}", style);
    }
  } else {
    // Pattern 2: Direct Action
    const activeDirects = isVi ? ACTIONS_DIRECT_VI[cat] : ACTIONS_DIRECT[cat];
    const directTemplate = activeDirects[(hashVal >>> 4) % activeDirects.length];
    coreSentence = directTemplate.replace("{topic}", topic).replace("{style}", style);
  }
  
  // Assemble greeting, core sentence, and format request
  let finalPrompt = "";
  if (greeting) {
    // Check capitalization of core sentence first letter
    const firstChar = coreSentence.charAt(0);
    const lowercaseIntro = greeting.endsWith(":") || greeting.endsWith(",");
    const adjustedCore = lowercaseIntro 
      ? firstChar.toLowerCase() + coreSentence.slice(1) 
      : coreSentence;
      
    finalPrompt = `${greeting} ${adjustedCore}`;
  } else {
    finalPrompt = coreSentence;
  }
  
  // Append formatting request
  finalPrompt = `${finalPrompt} ${format}`;
  
  return finalPrompt;
}

/**
 * Generates N unique prompts for account warmup
 * @param {number} count Number of prompts to generate
 * @param {string} seedString Optional string seed to generate deterministic prompts per account run
 * @returns {string[]} Array of unique, highly varied prompts
 */
export function generateWarmupPrompts(count = 3, seedString = '') {
  const prompts = [];
  
  // Track used topics in this batch to avoid repeating
  const usedTopics = new Set();
  
  for (let i = 0; i < count; i++) {
    // Force English prompts for warmup
    const isVi = false;
    
    const activeTopics = isVi ? TOPICS_VI : TOPICS;
    const activeFormats = isVi ? FORMATS_VI : FORMATS;
    const categories = Object.keys(activeTopics);
    
    let topic, format, cat, hashVal;
    
    if (seedString) {
      const qSeed = `${seedString}_q${i}`;
      hashVal = fnv1a(qSeed);
      
      cat = categories[hashVal % categories.length];
      const topicList = activeTopics[cat];
      
      let topicIdx = (hashVal >>> 2) % topicList.length;
      topic = topicList[topicIdx];
      
      let attempts = 0;
      while (usedTopics.has(topic) && attempts < 10) {
        const altHash = fnv1a(`${qSeed}_alt${attempts}`);
        topicIdx = altHash % topicList.length;
        topic = topicList[topicIdx];
        attempts++;
      }
      usedTopics.add(topic);
      
      format = activeFormats[(hashVal >>> 6) % activeFormats.length];
    } else {
      hashVal = Math.floor(Math.random() * 1000000);
      cat = categories[hashVal % categories.length];
      const topicList = activeTopics[cat];
      
      topic = topicList[Math.floor(Math.random() * topicList.length)];
      let attempts = 0;
      while (usedTopics.has(topic) && attempts < 10) {
        topic = topicList[Math.floor(Math.random() * topicList.length)];
        attempts++;
      }
      usedTopics.add(topic);
      
      format = activeFormats[Math.floor(Math.random() * activeFormats.length)];
    }
    
    const prompt = buildNaturalCombinatorialPrompt(cat, topic, format, hashVal, isVi);
    prompts.push(prompt);
  }
  
  return prompts;
}

/**
 * Fallback static list (backward compatibility)
 */
export const STATIC_QUESTIONS = [
  "Can you help me brainstorm some catchy names for a startup that builds AI-powered calendar tools?",
  "Explain the difference between SQL and NoSQL databases like I am five.",
  "Write a polite email to my manager asking for feedback on my recent project performance.",
  "What are some highly-rated non-touristy restaurants or cafes in Tokyo?",
  "Can you give me 3 quick, healthy, and delicious dinner recipes that take under 20 minutes to make?",
  "How does the virtual DOM work in React, and why is it faster than standard DOM manipulation?",
  "Help me outline a 4-week training plan for running a 5K race from scratch.",
  "What are the most common coding patterns or practices in clean architecture?",
  "Can you explain the main ideas behind Stoic philosophy and how to apply them to daily work stress?",
  "Give me some creative writing prompts involving a time traveler who gets stuck in the 1920s."
];
