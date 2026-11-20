// Starter categories and suggested channels.
// Category examples are phrases the on-device model compares videos with, so a video from any channel can
// land in a category (a Rust video from a general programming channel shows under Rust).
// Suggested channel handles were chosen from memory, not verified against YouTube: the Sources page lets the
// user tick which to add, and any handle YouTube can't find is flagged on the next refresh.

export const DEFAULT_CATEGORIES = [
  { id: "rust", name: "Rust", examples: ["rust programming tutorial", "async rust and tokio", "the rust borrow checker explained", "building a web server in rust", "what's new in rust 1.x", "rust vs c++ performance"] },
  { id: "ai", name: "AI & machine learning", examples: ["new AI model release explained", "how large language models work", "transformers and attention explained", "training a neural network from scratch", "AI research paper breakdown", "what's new in AI this week"] },
  { id: "systems", name: "Systems & low-level", examples: ["how operating systems work", "memory allocators and pointers", "how databases store data on disk", "TCP and networking explained", "writing a compiler", "CPU caches and performance"] },
  { id: "web", name: "Web development", examples: ["react and next.js tutorial", "javascript framework news", "CSS layout tricks", "building a full stack app", "typescript tips", "web performance and browsers"] },
  { id: "engineering", name: "Software engineering", examples: ["software architecture and system design", "clean code and refactoring", "conference talk on software design", "testing and continuous delivery", "career advice for software engineers", "design patterns explained"] },
  { id: "technews", name: "Tech news", examples: ["tech news this week", "new smartphone review", "big tech company announcement", "apple google microsoft event recap", "gadget and hardware review", "startup and industry news"] },
  { id: "science", name: "Science & math", examples: ["math concept explained visually", "physics explained", "science experiment", "how the universe works", "computer science theory explained", "engineering explained"] },
  { id: "fitness", name: "Fitness & health", examples: ["full body workout routine", "how to fix back pain", "build muscle and lose fat", "physiotherapy stretches", "healthy diet and nutrition tips", "yoga and mobility exercises"] },
  { id: "finance", name: "Finance & business", examples: ["stock market explained", "personal finance and investing tips", "how to start a business", "mutual funds and tax saving", "entrepreneur success story", "economy news analysis"] },
  { id: "mind", name: "Mind & spirituality", examples: ["meditation and inner peace", "spiritual talk on life", "motivational speech", "bhagavad gita explained", "self improvement and habits", "how to find purpose"] },
  { id: "music", name: "Music", examples: ["official music video", "new song release", "piano tutorial", "live concert performance", "bollywood songs", "how to play guitar"] },
  { id: "entertainment", name: "Comedy & entertainment", examples: ["stand up comedy special", "web series episode", "funny sketch", "movie trailer", "comedy podcast", "vlog"] },
  { id: "kids", name: "Kids", examples: ["nursery rhymes for kids", "cartoon for children", "kids learning songs", "parenting tips for toddlers", "children's story time", "baby songs"] },
];

/** [handle, display name, category id] */
export const SUGGESTED_CHANNELS = [
  ["@NoBoilerplate", "No Boilerplate", "rust"],
  ["@letsgetrusty", "Let's Get Rusty", "rust"],
  ["@jonhoo", "Jon Gjengset", "rust"],
  ["@codetothemoon", "Code to the Moon", "rust"],
  ["@chrisbiscardi", "Chris Biscardi", "rust"],

  ["@AndrejKarpathy", "Andrej Karpathy", "ai"],
  ["@TwoMinutePapers", "Two Minute Papers", "ai"],
  ["@YannicKilcher", "Yannic Kilcher", "ai"],
  ["@aiexplained-official", "AI Explained", "ai"],
  ["@umarjamilai", "Umar Jamil", "ai"],
  ["@statquest", "StatQuest", "ai"],
  ["@samwitteveenai", "Sam Witteveen", "ai"],

  ["@LowLevelTV", "Low Level", "systems"],
  ["@CoreDumpped", "Core Dumped", "systems"],
  ["@BenEater", "Ben Eater", "systems"],
  ["@hnasr", "Hussein Nasser", "systems"],
  ["@ByteByteGo", "ByteByteGo", "systems"],

  ["@Fireship", "Fireship", "web"],
  ["@t3dotgg", "Theo", "web"],
  ["@WebDevSimplified", "Web Dev Simplified", "web"],
  ["@KevinPowell", "Kevin Powell", "web"],

  ["@ThePrimeTimeagen", "ThePrimeTime", "engineering"],
  ["@ContinuousDelivery", "Continuous Delivery", "engineering"],
  ["@GOTO-", "GOTO Conferences", "engineering"],
  ["@CodeAesthetic", "CodeAesthetic", "engineering"],
  ["@ArjanCodes", "ArjanCodes", "engineering"],

  ["@TechLinked", "TechLinked", "technews"],
  ["@mkbhd", "Marques Brownlee", "technews"],
  ["@TheVerge", "The Verge", "technews"],

  ["@3blue1brown", "3Blue1Brown", "science"],
  ["@veritasium", "Veritasium", "science"],
  ["@Computerphile", "Computerphile", "science"],
  ["@numberphile", "Numberphile", "science"],
];
