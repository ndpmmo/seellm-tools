/**
 * ChatGPT Warmup Dynamic Prompt Generator Module
 * Generates highly natural, human-like, non-repetitive Q&A prompts
 * through combinatorics of topics, personas, formats, and contexts.
 */

// 1. Topic pools across diverse categories
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
    "the Page Visibility API in modern browsers"
  ],
  creative: [
    "a quiet morning in the foggy mountains",
    "a time traveler who gets stuck in Paris during the 1920s",
    "a humorous story about an AI coding assistant becoming overly dramatic",
    "a detective solving a mystery in a futuristic cyberpunk city",
    "a conversation between a philosopher and a smart home speaker",
    "a fantasy world where magic is treated like programming code",
    "the feeling of exploring an abandoned library in the middle of a forest"
  ],
  lifestyle: [
    "highly-rated non-touristy restaurants or cafes in Tokyo",
    "3 quick, healthy, and delicious dinner recipes under 20 minutes",
    "a 4-week training plan for running a 5K race from scratch",
    "fun weekend road trip destinations within 3 hours of San Francisco",
    "practical tips to improve public presentation skills for tech conferences",
    "how to design a minimalist and highly productive home office setup",
    "a beginner's guide to growing organic herbs on a small balcony"
  ],
  business: [
    "writing a polite feedback-request email to a project manager",
    "drafting a concise response to a client wanting to decrease budget",
    "writing a professional cover letter for a Senior Software Engineer position",
    "negotiating a freelance contract with a medium-sized startup",
    "outlining a pitch deck for a new mobile application idea",
    "best strategies for remote team onboarding and building trust",
    "how to run an effective sprint retrospective in agile development"
  ],
  learning: [
    "the difference between deep learning and traditional machine learning",
    "the main ideas behind Stoic philosophy and workplace stress management",
    "the difference between declarative and imperative programming styles",
    "how DNS resolution works step-by-step from browser to server",
    "key cognitive biases that affect software developers and managers",
    "the history of the Gutenberg printing press and its impact on society",
    "how quantum computing works using an analogy a high schooler would understand"
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
  "Can you write a creative piece about"
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
  "Organize with clear subheadings."
];

/**
 * Generates N unique prompts for account warmup
 * @param {number} count Number of prompts to generate
 * @returns {string[]} Array of unique, highly varied prompts
 */
export function generateWarmupPrompts(count = 3) {
  const prompts = [];
  const categories = Object.keys(TOPICS);
  
  // Keep track of used elements to maximize variety
  const usedTopics = new Set();
  
  for (let i = 0; i < count; i++) {
    // Pick a random category
    const cat = categories[Math.floor(Math.random() * categories.length)];
    const topicList = TOPICS[cat];
    
    // Find a topic not used in this batch if possible
    let topic = topicList[Math.floor(Math.random() * topicList.length)];
    let attempts = 0;
    while (usedTopics.has(topic) && attempts < 10) {
      topic = topicList[Math.floor(Math.random() * topicList.length)];
      attempts++;
    }
    usedTopics.add(topic);
    
    // Pick random persona and format
    const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
    const format = FORMATS[Math.floor(Math.random() * FORMATS.length)];
    
    // Combine them naturally
    // Example: "Explain to me like I am 5 years old SQL vs NoSQL database choice. Use a friendly, casual tone."
    const prompt = `${persona} ${topic}. ${format}`;
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
