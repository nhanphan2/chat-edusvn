// 🔥 api/chatbot.js - Vercel API Route with Enhanced Security
// Thay thế hoàn toàn Google Apps Script + Google Sheets

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, addDoc, limit } from 'firebase/firestore';

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
    this.maxMessageLength = 500; // Giới hạn độ dài message
    this.rateLimitWindow = 60 * 1000; // 1 phút
    this.maxRequestsPerWindow = 30; // 30 requests per minute
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

      // BƯỚC 1: Thử EXACT MATCH
      console.log('🎯 === STEP 1: Trying EXACT MATCH ===');
      const exactResponse = await this.findExactMatch(cleanMessage);
      
      if (exactResponse.found) {
        console.log('✅ EXACT MATCH found');
        await this.logQuery(cleanMessage, exactResponse, userId);
        
        return {
          success: true,
          response: exactResponse.answer,
          confidence: 1.0,
          category: exactResponse.category,
          matched_question: exactResponse.originalQuestion,
          match_type: 'exact',
          similarity: 1.0,
          timestamp: new Date().toISOString()
        };
      }

      // BƯỚC 2: Thử SIMILARITY MATCH
      console.log('🔍 === STEP 2: Trying SIMILARITY MATCH ===');
      const similarityResponse = await this.findSimilarityMatch(cleanMessage);
      
      if (similarityResponse.found) {
        console.log(`✅ SIMILARITY MATCH found - Confidence: ${similarityResponse.confidence}`);
        await this.logQuery(cleanMessage, similarityResponse, userId);
        
        return {
          success: true,
          response: similarityResponse.answer,
          confidence: similarityResponse.confidence,
          similarity: similarityResponse.similarity,
          category: similarityResponse.category,
          matched_question: similarityResponse.originalQuestion,
          match_type: 'similarity',
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
          confidence: similarityResponse.confidence || 0,
          similarity: similarityResponse.similarity || 0,
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

  // 🎯 Find exact match in Firestore
  async findExactMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 Searching for exact match: "${normalizedMessage}"`);

      const q = query(
        collection(this.db, 'data_chatbot'),
        where('normalized_questions', 'array-contains', normalizedMessage),
        limit(1)
      );

      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0];
        const data = doc.data();
        
        console.log('✅ EXACT MATCH FOUND!');
        
        return {
          found: true,
          answer: data.answer,
          category: data.category || 'general',
          originalQuestion: data.questions[0],
          docId: doc.id,
          confidence: 1.0,
          similarity: 1.0,
          matchType: 'exact'
        };
      }

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

  // 🔍 Find similarity match in Firestore
  async findSimilarityMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      const messageWords = normalizedMessage.split(' ').filter(word => word.length > 1);
      
      console.log(`🔍 Searching for similarity with words: [${messageWords.join(', ')}]`);

      if (messageWords.length === 0) {
        return {
          found: false,
          answer: '',
          category: 'no_match',
          confidence: 0,
          similarity: 0,
          matchType: 'none'
        };
      }

      const q = query(
        collection(this.db, 'data_chatbot'),
        where('keywords', 'array-contains-any', messageWords),
        limit(50)
      );

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

      querySnapshot.docs.forEach(doc => {
        const data = doc.data();
        
        data.questions.forEach(question => {
          const similarity = this.calculateSimilarity(normalizedMessage, question);
          
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestMatch = {
              answer: data.answer,
              category: data.category || 'general',
              originalQuestion: question,
              docId: doc.id,
              similarity: similarity
            };
          }
        });
      });

      const confidence = this.getConfidenceLevel(bestSimilarity);

      if (confidence >= 0.75) {
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

  // 🧮 Calculate Jaccard similarity
  calculateSimilarity(query, target) {
    const queryWords = this.normalizeText(query).split(' ').filter(word => word.length > 1);
    const targetWords = this.normalizeText(target).split(' ').filter(word => word.length > 1);
    
    if (queryWords.length === 0 || targetWords.length === 0) return 0;
    
    const querySet = new Set(queryWords);
    const targetSet = new Set(targetWords);
    
    const intersection = new Set([...querySet].filter(x => targetSet.has(x)));
    const union = new Set([...querySet, ...targetSet]);
    
    if (union.size === 0) return 0;
    
    return intersection.size / union.size;
  }

  // 🎯 Get confidence level
  getConfidenceLevel(similarity) {
    if (similarity >= 1.0) return 1.0;
    else if (similarity >= 0.9) return 0.95;
    else if (similarity >= 0.8) return 0.85;
    else if (similarity >= 0.7) return 0.75;
    else return similarity;
  }

  // 🧹 Normalize text
  normalizeText(text) {
    if (!text) return '';
    
    return text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[áàảãạăắằẳẵặâấầẩẫậ]/g, 'a')
      .replace(/[éèẻẽẹêếềểễệ]/g, 'e')
      .replace(/[íìỉĩị]/g, 'i')
      .replace(/[óòỏõọôốồổỗộơớờởỡợ]/g, 'o')
      .replace(/[úùủũụưứừửữự]/g, 'u')
      .replace(/[ýỳỷỹỵ]/g, 'y')
      .replace(/đ/g, 'd')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
