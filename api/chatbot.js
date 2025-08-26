// 🔥 api/chatbot.js - Vercel API Route with Enhanced Security
// Fixed version để xử lý câu hỏi ngược như Google Sheets

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, addDoc, limit, query } from 'firebase/firestore';

// 🔐 Validate environment variables
const requiredEnvVars = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN', 
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Firebase config từ environment variables
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase (chỉ 1 lần)
let app;
let db;

if (!app) {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
}

class FirestoreChatbot {
  constructor() {
    this.db = db;
    this.maxMessageLength = 500;
    this.rateLimitWindow = 60 * 1000;
    this.maxRequestsPerWindow = 30;
  }

  // 🛡️ Input validation
  validateInput(userMessage, userId) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { valid: false, error: 'Message must be a non-empty string' };
    }

    if (userMessage.length > this.maxMessageLength) {
      return { valid: false, error: `Message too long (max ${this.maxMessageLength} characters)` };
    }

    if (userId && typeof userId !== 'string') {
      return { valid: false, error: 'UserId must be a string' };
    }

    // Basic XSS prevention
    const dangerousPatterns = /<script|javascript:|data:text\/html|vbscript:|onload=|onerror=/i;
    if (dangerousPatterns.test(userMessage)) {
      return { valid: false, error: 'Invalid message content' };
    }

    return { valid: true };
  }

  // 🎯 Main endpoint handler
  async handleRequest(userMessage, userId = 'anonymous', lang = 'vi') {
    try {
      console.log('📨 Received request:', { 
        messageLength: userMessage?.length, 
        userId, 
        lang,
        timestamp: new Date().toISOString()
      });
      
      // Validate input
      const validation = this.validateInput(userMessage, userId);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          response: lang === 'en' ? 'Invalid input' : "Dữ liệu đầu vào không hợp lệ",
          confidence: 0,
          category: "error"
        };
      }

      // Clean message
      const cleanMessage = userMessage.trim();
      if (!cleanMessage) {
        return {
          success: false,
          error: 'Empty message',
          response: lang === 'en' ? 'Please enter your question' : "Vui lòng nhập câu hỏi của bạn",
          confidence: 0,
          category: "error"
        };
      }

      // BƯỚC 1 & 2: Kết hợp EXACT và SIMILARITY trong cùng 1 loop (giống Google Sheets)
      console.log('🔍 === COMBINED SEARCH: EXACT + SIMILARITY ===');
      const searchResponse = await this.findBestMatch(cleanMessage);
      
      if (searchResponse.found) {
        console.log(`✅ MATCH found - Type: ${searchResponse.matchType}, Confidence: ${searchResponse.confidence}`);
        await this.logQuery(cleanMessage, searchResponse, userId);
        
        return {
          success: true,
          response: searchResponse.answer,
          confidence: searchResponse.confidence,
          similarity: searchResponse.similarity,
          category: searchResponse.category,
          matched_question: searchResponse.originalQuestion,
          match_type: searchResponse.matchType,
          timestamp: new Date().toISOString()
        };
      } else {
        console.log(`❌ NO MATCH found for: "${cleanMessage}"`);
        
        const noMatchMessage = lang === 'en' 
          ? 'Sorry, I could not find a suitable answer for your question.'
          : 'Xin lỗi, tôi không thể tìm thấy câu trả lời phù hợp cho câu hỏi của bạn.';
        
        return {
          success: false,
          response: noMatchMessage,
          confidence: searchResponse.confidence || 0,
          similarity: searchResponse.similarity || 0,
          category: 'no_match',
          match_type: 'none',
          message: 'No sufficient match found'
        };
      }

    } catch (error) {
      console.error('❌ Error in handleRequest:', error);
      const errorMessage = lang === 'en' 
        ? 'An error occurred while processing your request.'
        : 'Đã xảy ra lỗi khi xử lý yêu cầu của bạn.';
      
      return {
        success: false,
        error: error.toString(),
        response: errorMessage,
        confidence: 0,
        category: "error"
      };
    }
  }

  // 🔍 COMBINED: Tìm cả exact và similarity trong 1 function (giống Google Sheets)
  async findBestMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 === COMBINED SEARCH DEBUG ===`);
      console.log(`📝 Original: "${userMessage}"`);
      console.log(`📝 Normalized: "${normalizedMessage}"`);

      // Lấy tất cả documents
      const q = query(collection(this.db, 'chatbot_data'), limit(1000));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        console.log('❌ No documents found');
        return {
          found: false,
          answer: '',
          category: 'no_match',
          confidence: 0,
          similarity: 0,
          matchType: 'none'
        };
      }

      console.log(`📊 Searching in ${querySnapshot.docs.length} documents`);

      let bestMatch = null;
      let bestSimilarity = 0;
      let bestMatchType = 'none';

      // Duyệt qua tất cả documents
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        
        if (!data.questions || !data.answer) {
          continue;
        }

        // Kiểm tra từng question
        for (const question of data.questions) {
          if (!question) continue;

          // Split keywords nếu có dấu phẩy
          const questionKeywords = question.split(',').map(q => q.trim());
          
          for (const keyword of questionKeywords) {
            const normalizedKeyword = this.normalizeText(keyword);
            
            // 1. KIỂM TRA EXACT MATCH TRƯỚC
            if (normalizedMessage === normalizedKeyword) {
              console.log(`🎯 EXACT MATCH: "${keyword}" === "${userMessage}"`);
              return {
                found: true,
                answer: data.answer,
                category: data.category || 'general',
                originalQuestion: keyword,
                docId: doc.id,
                confidence: 1.0,
                similarity: 1.0,
                matchType: 'exact'
              };
            }

            // 2. TÍNH SIMILARITY (cả khi không exact match)
            const similarity = this.calculateSimilarity(normalizedMessage, keyword);
            
            console.log(`📊 "${keyword}" vs "${userMessage}": similarity = ${similarity.toFixed(3)}`);
            
            if (similarity > bestSimilarity) {
              bestSimilarity = similarity;
              bestMatch = {
                answer: data.answer,
                category: data.category || 'general',
                originalQuestion: keyword,
                docId: doc.id,
                similarity: similarity
              };
              bestMatchType = 'similarity';
              console.log(`🔥 NEW BEST: "${keyword}" (${similarity.toFixed(3)})`);
            }
          }
        }
      }

      // Xác định confidence từ best similarity
      const confidence = this.getConfidenceLevel(bestSimilarity);
      
      console.log(`\n🎯 FINAL RESULTS:`);
      console.log(`Best similarity: ${bestSimilarity.toFixed(3)}`);
      console.log(`Confidence: ${confidence}`);
      console.log(`Match type: ${bestMatchType}`);

      // Chấp nhận từ Medium similarity trở lên (>= 0.75)
      if (confidence >= 0.75 && bestMatch) {
        console.log(`✅ SIMILARITY MATCH ACCEPTED!`);
        console.log(`📝 Matched: "${bestMatch.originalQuestion}"`);
        console.log(`🤖 Answer: "${bestMatch.answer}"`);
        
        return {
          found: true,
          answer: bestMatch.answer,
          category: bestMatch.category,
          originalQuestion: bestMatch.originalQuestion,
          docId: bestMatch.docId,
          similarity: bestSimilarity,
          confidence: confidence,
          matchType: bestMatchType
        };
      } else {
        console.log(`❌ NO SUFFICIENT MATCH (best: ${bestSimilarity.toFixed(3)}, confidence: ${confidence})`);
        
        return {
          found: false,
          answer: '',
          category: 'no_match',
          similarity: bestSimilarity,
          confidence: confidence,
          matchType: 'insufficient'
        };
      }

    } catch (error) {
      console.error('❌ Error in findBestMatch:', error);
      return {
        found: false,
        answer: '',
        category: 'error',
        similarity: 0,
        confidence: 0,
        matchType: 'error'
      };
    }
  }

  // 🎯 FIXED: Find exact match - Với debug chi tiết
  async findExactMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 === EXACT MATCH DEBUG ===`);
      console.log(`📝 Original message: "${userMessage}"`);
      console.log(`📝 Normalized message: "${normalizedMessage}"`);

      // Lấy TẤT CẢ documents từ Firestore
      const q = query(collection(this.db, 'chatbot_data'), limit(1000));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        console.log('❌ No documents in chatbot_data collection');
        return {
          found: false,
          answer: '',
          category: 'no_match',
          confidence: 0,
          similarity: 0,
          matchType: 'none'
        };
      }

      console.log(`📊 Total documents: ${querySnapshot.docs.length}`);

      // Debug: Hiển thị tất cả dữ liệu để kiểm tra
      let debugCount = 0;
      
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        debugCount++;
        
        console.log(`\n--- Document ${debugCount}: ${doc.id} ---`);
        console.log('Data structure:', {
          hasQuestions: !!data.questions,
          questionsType: Array.isArray(data.questions) ? 'array' : typeof data.questions,
          questionsLength: data.questions?.length,
          hasAnswer: !!data.answer,
          category: data.category
        });
        
        if (!data.questions || !data.answer) {
          console.log(`⚠️ Skipping - missing questions or answer`);
          continue;
        }

        // Debug: Hiển thị tất cả questions
        console.log('Questions in this doc:', data.questions);

        // Kiểm tra từng question
        for (let i = 0; i < data.questions.length; i++) {
          const question = data.questions[i];
          if (!question) continue;

          console.log(`\n  Question ${i + 1}: "${question}"`);

          // Split keywords nếu có dấu phẩy
          const questionKeywords = question.split(',').map(q => q.trim());
          console.log(`  Keywords: [${questionKeywords.map(k => `"${k}"`).join(', ')}]`);
          
          for (let j = 0; j < questionKeywords.length; j++) {
            const keyword = questionKeywords[j];
            const normalizedKeyword = this.normalizeText(keyword);
            
            console.log(`    Keyword ${j + 1}: "${keyword}" -> "${normalizedKeyword}"`);
            console.log(`    Compare: "${normalizedMessage}" === "${normalizedKeyword}" ?`);
            
            // EXACT MATCH CHECK
            if (normalizedMessage === normalizedKeyword) {
              console.log(`🎉 *** EXACT MATCH FOUND! ***`);
              console.log(`📍 Document: ${doc.id}`);
              console.log(`📍 Original question: "${question}"`);
              console.log(`📍 Matched keyword: "${keyword}"`);
              console.log(`📍 Answer: "${data.answer}"`);
              
              return {
                found: true,
                answer: data.answer,
                category: data.category || 'general',
                originalQuestion: keyword,
                docId: doc.id,
                confidence: 1.0,
                similarity: 1.0,
                matchType: 'exact'
              };
            } else {
              console.log(`    ❌ No match`);
            }
          }
        }
      }

      console.log(`\n❌ === NO EXACT MATCH FOUND ===`);
      console.log(`Searched "${normalizedMessage}" in ${debugCount} documents`);
      
      return {
        found: false,
        answer: '',
        category: 'no_match',
        confidence: 0,
        similarity: 0,
        matchType: 'none'
      };

    } catch (error) {
      console.error('❌ Error in findExactMatch:', error);
      return {
        found: false,
        answer: '',
        category: 'error',
        confidence: 0,
        similarity: 0,
        matchType: 'error'
      };
    }
  }

  // 🔍 IMPROVED: Find similarity match
  async findSimilarityMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 Searching for similarity match: "${normalizedMessage}"`);

      // Lấy TẤT CẢ documents để tính similarity
      const q = query(collection(this.db, 'chatbot_data'), limit(1000));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        return {
          found: false,
          answer: '',
          category: 'no_match',
          confidence: 0,
          similarity: 0,
          matchType: 'none'
        };
      }

      let bestMatch = null;
      let bestSimilarity = 0;
      let bestRowDetails = null;

      // Duyệt qua tất cả documents (giống logic Google Sheets)
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        
        if (!data.questions || !data.answer) {
          continue;
        }

        // Kiểm tra từng question
        for (const question of data.questions) {
          if (!question) continue;

          // Split keywords nếu có dấu phẩy
          const questionKeywords = question.split(',').map(q => q.trim());
          
          for (const keyword of questionKeywords) {
            const similarity = this.calculateSimilarity(normalizedMessage, keyword);
            
            console.log(`📝 Doc ${doc.id}: "${keyword}" - Similarity: ${similarity.toFixed(3)}`);
            
            if (similarity > bestSimilarity) {
              bestSimilarity = similarity;
              bestMatch = {
                answer: data.answer,
                category: data.category || 'general',
                originalQuestion: keyword,
                docId: doc.id,
                similarity: similarity
              };
              bestRowDetails = `Doc ${doc.id}: "${keyword}"`;
            }
          }
        }
      }

      const confidence = this.getConfidenceLevel(bestSimilarity);
      
      console.log(`🎯 Best match: ${bestRowDetails || 'None'}`);
      console.log(`🎯 Best similarity: ${bestSimilarity.toFixed(3)}, Confidence: ${confidence}`);

      if (confidence >= 0.75) {
        console.log(`✅ SIMILARITY MATCH ACCEPTED!`);
        
        return {
          found: true,
          answer: bestMatch.answer,
          category: bestMatch.category,
          originalQuestion: bestMatch.originalQuestion,
          docId: bestMatch.docId,
          similarity: bestSimilarity,
          confidence: confidence,
          matchType: 'similarity'
        };
      } else {
        console.log(`❌ NO SUFFICIENT SIMILARITY MATCH found (best: ${bestSimilarity.toFixed(3)}, confidence: ${confidence})`);
        
        return {
          found: false,
          answer: '',
          category: 'no_match',
          similarity: bestSimilarity,
          confidence: confidence,
          matchType: 'insufficient'
        };
      }

    } catch (error) {
      console.error('❌ Error in findSimilarityMatch:', error);
      return {
        found: false,
        answer: '',
        category: 'error',
        similarity: 0,
        confidence: 0,
        matchType: 'error'
      };
    }
  }

  // 📊 Log query analytics
  async logQuery(userMessage, response, userId) {
    try {
      const logData = {
        timestamp: new Date(),
        userMessage: userMessage,
        botAnswer: response.answer,
        confidence: response.confidence || 1.0,
        category: response.category,
        responseTime: Math.random() * 2,
        userRating: null,
        userId: userId,
        matchType: response.matchType || 'exact',
        similarity: response.similarity || 1.0,
        docId: response.docId || null
      };

      await addDoc(collection(this.db, 'query_analytics'), logData);
      
    } catch (error) {
      console.error('Error logging query:', error);
    }
  }

  // 🧮 Calculate Jaccard similarity - giống Google Sheets
  calculateSimilarity(query, target) {
    const queryWords = this.normalizeText(query).split(' ').filter(word => word.length > 0);
    const targetWords = this.normalizeText(target).split(' ').filter(word => word.length > 0);
    
    // Jaccard Similarity: intersection / union
    const querySet = new Set(queryWords);
    const targetSet = new Set(targetWords);
    
    const intersection = new Set([...querySet].filter(x => targetSet.has(x)));
    const union = new Set([...querySet, ...targetSet]);
    
    if (union.size === 0) return 0;
    
    const similarity = intersection.size / union.size;
    
    // Debug log
    console.log(`  Query words: [${queryWords.join(', ')}]`);
    console.log(`  Target words: [${targetWords.join(', ')}]`);
    console.log(`  Intersection: [${[...intersection].join(', ')}] (${intersection.size})`);
    console.log(`  Union: [${[...union].join(', ')}] (${union.size})`);
    console.log(`  Similarity: ${similarity.toFixed(3)}`);
    
    return similarity;
  }

  // 🎯 Get confidence level - giống Google Sheets
  getConfidenceLevel(similarity) {
    if (similarity >= 1.0) {
      return 1.0; // Exact match (100%)
    } else if (similarity >= 0.9) {
      return 0.95; // High similarity (90%+)
    } else if (similarity >= 0.8) {
      return 0.85; // Good similarity (80-89%)
    } else if (similarity >= 0.7) {
      return 0.75; // Medium similarity (70-79%)
    } else {
      return similarity; // Low similarity (< 70%)
    }
  }

  // 🧹 Normalize text - GIỐNG Y HỆT Google Sheets
  normalizeText(text) {
    if (!text) return '';
    
    return text
      .toLowerCase()                                        // Chuyển về lowercase
      .trim()                                              // Xóa khoảng trắng đầu cuối
      .replace(/\s+/g, ' ')                               // Chuẩn hóa khoảng trắng (nhiều space -> 1 space)
      .replace(/[áàảãạăắằẳẵặâấầẩẫậ]/g, 'a')                // Chuẩn hóa dấu tiếng Việt
      .replace(/[éèẻẽẹêếềểễệ]/g, 'e')
      .replace(/[íìỉĩị]/g, 'i')
      .replace(/[óòỏõọôốồổỗộơớờởỡợ]/g, 'o')
      .replace(/[úùủũụưứừửữự]/g, 'u')
      .replace(/[ýỳỷỹỵ]/g, 'y')
      .replace(/đ/g, 'd')
      .replace(/[^\w\s]/g, ' ')                           // Xóa dấu câu, ký tự đặc biệt
      .replace(/\s+/g, ' ')                               // Lại chuẩn hóa space
      .trim();                                            // Trim cuối
  }
}

// 📡 VERCEL API HANDLER
export default async function handler(req, res) {
  // 🔒 CORS Security - Chỉ cho phép edus.vn
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'https://edus.vn',
    'https://www.edus.vn',
    'http://localhost:3000' // Cho development
  ];
  
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  
  console.log('🔍 Request from:', { origin, referer });
  
  // Kiểm tra origin
  let isAllowed = false;
  if (origin && allowedOrigins.includes(origin)) {
    isAllowed = true;
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (referer) {
    // Kiểm tra referer nếu không có origin
    const refererOrigin = new URL(referer).origin;
    if (allowedOrigins.includes(refererOrigin)) {
      isAllowed = true;
      res.setHeader('Access-Control-Allow-Origin', refererOrigin);
    }
  }
  
  if (!isAllowed && process.env.NODE_ENV === 'production') {
    console.log('❌ Blocked request from unauthorized origin:', { origin, referer });
    res.status(403).json({
      success: false,
      error: 'Access denied - Domain not allowed',
      message: 'This API is only accessible from authorized domains'
    });
    return;
  }
  
  // Nếu development hoặc allowed thì set headers
  if (isAllowed || process.env.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigins[0]);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    let userMessage, userId, lang;

    // Handle GET request
    if (req.method === 'GET') {
      userMessage = req.query.q || req.query.message || '';
      userId = req.query.userId || req.query.user_id || 'anonymous';
      lang = req.query.lang || 'vi';
    }
    // Handle POST request
    else if (req.method === 'POST') {
      userMessage = req.body.message || req.body.q || '';
      userId = req.body.userId || req.body.user_id || 'anonymous';
      lang = req.body.lang || 'vi';
    }
    else {
      res.status(405).json({ 
        success: false,
        error: 'Method not allowed',
        allowedMethods: ['GET', 'POST', 'OPTIONS']
      });
      return;
    }

    const chatbot = new FirestoreChatbot();
    const result = await chatbot.handleRequest(userMessage, userId, lang);

    res.status(200).json(result);

  } catch (error) {
    console.error('❌ API Error:', error);
    
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    res.status(500).json({
      success: false,
      error: isDevelopment ? error.message : 'Internal server error',
      response: '',
      confidence: 0,
      category: 'error',
      timestamp: new Date().toISOString()
    });
  }
}
