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

// 1. Topic pools across diverse categories (highly expanded for maximum variation)
const TOPICS = {
  technology: [
    "virtual DOM in modern frontend frameworks",
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
    "a humorous story about an AI coding assistant becoming overly dramatic",
    "a detective solving a mystery in a futuristic cyberpunk city",
    "a conversation between a philosopher and a smart home speaker",
    "a fantasy world where magic is treated like programming code",
    "the feeling of exploring an abandoned library in the middle of a forest",
    "a coffee shop owner who discovers they can read minds but only about coffee orders",
    "a story about the last library on Earth operating on a satellite",
    "a dialogue between two trees who have watched a city grow around them for 200 years",
    "a whimsical fairy tale about a dragon who is afraid of fire and prefers baking",
    "a sci-fi thriller about a submariner crew encountering a mysterious ancient vault at the bottom of the Mariana Trench",
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
    "highly-rated non-touristy restaurants or cafes in Tokyo",
    "3 quick, healthy, and delicious dinner recipes under 20 minutes",
    "a 4-week training plan for running a 5K race from scratch",
    "fun weekend road trip destinations within 3 hours of San Francisco",
    "practical tips to improve public presentation skills for tech conferences",
    "how to design a minimalist and highly productive home office setup",
    "a beginner's guide to growing organic herbs on a small balcony",
    "top outdoor hiking and camping destinations in the Pacific Northwest",
    "simple mindfulness techniques to reduce daily screen fatigue",
    "a curated list of coffee brewing methods and how they affect taste profile",
    "how to build a sustainable capsule wardrobe on a budget",
    "practical meal prep strategies for busy remote developers",
    "creating a weekly routine for learning a new language in 15 minutes a day",
    "a 10-minute morning stretching routine for office workers to relieve stiffness",
    "simple meal planning guide to reduce food waste and save budget",
    "tips for maintaining long-distance friendships while working remotely",
    "a list of indoor house plants that require minimal sunlight and care",
    "how to organize a digital clutter clean-up for your computer and phone",
    "the health benefits of drinking loose leaf green tea daily",
    "a beginner's guide to journaling for mental clarity and goal tracking",
    "how to build a basic travel packing list for light-weight carry-on travel",
    "practical strategies for falling asleep naturally without screens"
  ],
  business: [
    "writing a polite feedback-request email to a project manager",
    "drafting a concise response to a client wanting to decrease budget",
    "writing a professional cover letter for a Senior Software Engineer position",
    "negotiating a freelance contract with a medium-sized startup",
    "outlining a pitch deck for a new mobile application idea",
    "best strategies for remote team onboarding and building trust",
    "how to run an effective sprint retrospective in agile development",
    "crafting a perfect LinkedIn outreach message to an industry recruiter",
    "how to prioritize tasks using the Eisenhower Matrix for startup founders",
    "best practices for preparing and presenting annual budget reviews",
    "how to establish healthy boundaries as a contractor working with multiple clients",
    "resolving a communication bottleneck between product managers and engineering teams",
    "negotiating a salary increase during a performance review",
    "how to write a brief project proposal for cross-departmental approval",
    "best practices for delegating tasks as a newly promoted manager",
    "how to handle a difficult conversation with an underperforming team member",
    "crafting an elevator pitch for a software-as-a-service (SaaS) product",
    "strategies for staying focused during long virtual meetings",
    "how to organize and categorize project requirements using user stories",
    "the difference between cap tables and equity shares in a startup",
    "best practices for reviewing pull requests constructively as a lead developer",
    "how to calculate customer acquisition cost (CAC) and lifetime value (LTV)"
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

// Pools in Vietnamese to support dynamic localized prompting
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
    "công cụ quản lý lịch hẹn bằng AI giúp tăng năng suất làm việc thế nào",
    "tầm quan trọng của Page Visibility API trong lập trình web hiện đại"
  ],
  creative: [
    "một buổi sáng bình yên đầy sương mù trên đỉnh núi Đà Lạt",
    "chuyện một người du hành thời gian bị kẹt lại Hà Nội những năm 1930",
    "câu chuyện hài hước về một trợ lý AI viết code bỗng dưng trở nên cực kỳ sướt mướt",
    "một thám tử tư giải quyết vụ án mạng kỳ bí trong thành phố tương lai cyberpunk",
    "cuộc đối thoại triết học giữa một nhà hiền triết và chiếc loa thông minh trong nhà",
    "một thế giới giả tưởng nơi phép thuật được vận hành như mã nguồn lập trình"
  ],
  lifestyle: [
    "các quán cà phê yên tĩnh, thích hợp làm việc tại trung tâm Sài Gòn",
    "3 công thức món ăn tối dinh dưỡng, dễ làm trong vòng dưới 20 phút",
    "lộ trình tập luyện 4 tuần để chạy được 5km liên tục cho người mới bắt đầu",
    "các địa điểm cắm trại cuối tuần tuyệt đẹp cách Hà Nội dưới 3 tiếng di chuyển",
    "mẹo cải thiện kỹ năng thuyết trình trước đám đông cho lập trình viên",
    "cách thiết kế góc làm việc tại nhà tối giản và tạo cảm hứng",
    "hướng dẫn chi tiết cách trồng rau sạch và thảo mộc ngoài ban công chung cư"
  ],
  business: [
    "cách viết email lịch sự gửi quản lý để xin đánh giá hiệu quả công việc",
    "cách viết phản hồi chuyên nghiệp khi khách hàng đột ngột đòi giảm ngân sách",
    "viết thư xin việc chuyên nghiệp ứng tuyển vị trí Kỹ sư Phần mềm Cao cấp",
    "kinh nghiệm đàm phán hợp đồng freelance với một công ty startup công nghệ",
    "dàn ý bài thuyết trình Pitch Deck kêu gọi vốn cho một ứng dụng di động mới",
    "các phương pháp giúp onboarding nhân sự làm việc từ xa hiệu quả nhất",
    "cách tổ chức một buổi họp cải tiến Sprint Retrospective hiệu quả trong mô hình Agile"
  ]
};

// 2. Persona/Vibe qualifiers to make it sound human-like and spontaneous
const PERSONAS = [
  "Explain to me like I am 5 years old",
  "Can you write a detailed guide about",
  "Help me brainstorm some ideas on",
  "What is the best way to understand",
  "I am looking for some practical advice on",
  "Can you give me a simple and clear overview of",
  "Could you help me outline",
  "I am curious about",
  "What are the most common practices for",
  "Can you write a creative piece about",
  "Give me a critical analysis of",
  "I need a comparative study of",
  "Can you draft a comprehensive guide about",
  "What are the key points to remember regarding",
  "Please explain the fundamental concepts of",
  "I am looking for a creative perspective on"
];

const PERSONAS_VI = [
  "Giải thích cho tôi một cách cực kỳ đơn giản dễ hiểu về",
  "Bạn có thể viết một hướng dẫn chi tiết về",
  "Giúp tôi lên ý tưởng và brainstorm về",
  "Cách tốt nhất để hiểu rõ về",
  "Tôi đang tìm kiếm một số lời khuyên thực tế về",
  "Hãy cho tôi một cái nhìn tổng quan ngắn gọn và rõ ràng về",
  "Bạn có thể giúp tôi lập dàn ý cho",
  "Tôi đang rất tò mò tìm hiểu về",
  "Những phương pháp phổ biến nhất để xử lý",
  "Hãy viết một bài viết sáng tạo đầy cảm hứng về"
];

// 3. Format constraints or follow-ups to diversify output structure
const FORMATS = [
  "Use bullet points for key takeaways.",
  "Keep the tone professional and warm.",
  "Use a friendly, casual, conversational tone.",
  "Include a short summary at the end.",
  "Give clear step-by-step instructions.",
  "Explain with a simple real-world analogy.",
  "Keep it concise and straight to the point.",
  "Provide a couple of realistic examples.",
  "Organize with clear subheadings.",
  "Format the response with code snippets where applicable.",
  "Include a table comparing the main aspects.",
  "Write in the style of an educational blog post.",
  "End with a list of frequently asked questions.",
  "Structure the explanation from simplest to most advanced concepts."
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
    const activePersonas = isVi ? PERSONAS_VI : PERSONAS;
    const activeFormats = isVi ? FORMATS_VI : FORMATS;
    const categories = Object.keys(activeTopics);
    
    let persona, topic, format, templateId;
    
    if (seedString) {
      const qSeed = `${seedString}_q${i}`;
      const hashVal = fnv1a(qSeed);
      
      const cat = categories[hashVal % categories.length];
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
      
      persona = activePersonas[(hashVal >>> 4) % activePersonas.length];
      format = activeFormats[(hashVal >>> 6) % activeFormats.length];
      templateId = (hashVal >>> 8) % 5;
    } else {
      const cat = categories[Math.floor(Math.random() * categories.length)];
      const topicList = activeTopics[cat];
      
      topic = topicList[Math.floor(Math.random() * topicList.length)];
      let attempts = 0;
      while (usedTopics.has(topic) && attempts < 10) {
        topic = topicList[Math.floor(Math.random() * topicList.length)];
        attempts++;
      }
      usedTopics.add(topic);
      
      persona = activePersonas[Math.floor(Math.random() * activePersonas.length)];
      format = activeFormats[Math.floor(Math.random() * activeFormats.length)];
      templateId = Math.floor(Math.random() * 5);
    }
    
    // Select a template layout dynamically to create different syntactical structures
    let prompt = '';
    
    if (isVi) {
      switch (templateId) {
        case 0:
          prompt = `${persona} ${topic}. ${format}`;
          break;
        case 1:
          prompt = `Tôi muốn hỏi: ${persona} ${topic}? ${format}`;
          break;
        case 2:
          prompt = `Tôi đang tìm hiểu về ${topic}. ${persona} chủ đề này? ${format}`;
          break;
        case 3:
          prompt = `Bạn có thể giải thích chi tiết giúp tôi về ${topic} không? ${format}`;
          break;
        case 4:
        default:
          prompt = `Cho tôi hỏi ${topic}. ${format}`;
          break;
      }
    } else {
      switch (templateId) {
        case 0:
          prompt = `${persona} ${topic}. ${format}`;
          break;
        case 1:
          prompt = `Quick question: ${persona} ${topic}? ${format}`;
          break;
        case 2:
          prompt = `I am currently studying ${topic}. ${persona} this? ${format}`;
          break;
        case 3:
          prompt = `Could you write a detailed breakdown of ${topic}? ${format}`;
          break;
        case 4:
        default:
          prompt = `I need help with ${topic}. ${format}`;
          break;
      }
    }
    
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
