// 🔥 api/chatbot.js - Vercel API Route with Semantic Search
// Thay thế hoàn toàn Google Apps Script + Google Sheets

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, addDoc, limit } from 'firebase/firestore';
import OpenAI from 'openai';

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
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // 🎯 Main endpoint handler
  async handleRequest(userMessage, userId = 'anonymous', lang = 'vi') {
    try {
      console.log('📨 Received request:', { userMessage, userId, lang });
      
      if (!userMessage) {
        return {
          success: false,
          error: 'No message provided',
          response: "Vui lòng nhập câu hỏi của bạn",
          confidence: 0,
          category: "error"
        };
      }

      // BƯỚC 1: Thử EXACT MATCH
      console.log('🎯 === STEP 1: Trying EXACT MATCH ===');
      const exactResponse = await this.findExactMatch(userMessage);
      
      if (exactResponse.found) {
        console.log('✅ EXACT MATCH found');
        await this.logQuery(userMessage, exactResponse, userId);
        
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
      const similarityResponse = await this.findSimilarityMatch(userMessage);
      
      if (similarityResponse.found) {
        console.log(`✅ SIMILARITY MATCH found - Confidence: ${similarityResponse.confidence}`);
        await this.logQuery(userMessage, similarityResponse, userId);
        
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
      }

      // BƯỚC 3: Thử SEMANTIC MATCH
      console.log('🧠 === STEP 3: Trying SEMANTIC MATCH ===');
      const semanticResponse = await this.findSemanticMatch(userMessage);

      if (semanticResponse.found) {
        console.log(`✅ SEMANTIC MATCH found - Confidence: ${semanticResponse.confidence}`);
        await this.logQuery(userMessage, semanticResponse, userId);
        
        return {
          success: true,
          response: semanticResponse.answer,
          confidence: semanticResponse.confidence,
          similarity: semanticResponse.similarity,
          category: semanticResponse.category,
          matched_question: semanticResponse.originalQuestion,
          match_type: 'semantic',
          timestamp: new Date().toISOString()
        };
      } else {
        console.log(`❌ NO MATCH found for: "${userMessage}"`);
        
        return {
          success: false,
          response: '',
          confidence: semanticResponse.confidence || 0,
          similarity: semanticResponse.similarity || 0,
          category: 'no_match',
          match_type: 'none',
          message: 'No sufficient match found'
        };
      }

    } catch (error) {
      console.error('❌ Error in handleRequest:', error);
      return {
        success: false,
        error: error.toString(),
        response: '',
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
        collection(this.db, 'chatbot_data'),
        where('normalized_questions', 'array-contains', normalizedMessage),
        limit(1)
      );

      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0];
        const data = doc.data();
        
        console.log('✅ EXACT MATCH FOUND!');
        
        // Handle different data structures for questions
        let originalQuestion;
        if (Array.isArray(data.questions)) {
          originalQuestion = data.questions[0];
        } else if (typeof data.questions === 'string') {
          originalQuestion = data.questions.split(',')[0].trim();
        } else {
          originalQuestion = data.questions || 'Unknown question';
        }
        
        return {
          found: true,
          answer: data.answer,
          category: data.category || 'general',
          originalQuestion: originalQuestion,
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
      const messageWords = normalizedMessage.split(' ').filter(word => word.length > 0);
      
      console.log(`🔍 Searching for similarity with words: [${messageWords.join(', ')}]`);

      const q = query(
        collection(this.db, 'chatbot_data'),
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
        
        // Handle different question formats
        let questionsArray = [];
        if (Array.isArray(data.questions)) {
          questionsArray = data.questions;
        } else if (typeof data.questions === 'string') {
          questionsArray = data.questions.split(',').map(q => q.trim());
        } else if (data.questions) {
          questionsArray = [data.questions];
        }

        questionsArray.forEach(question => {
          if (!question) return;
          
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

  // 🧠 Find semantic match using OpenAI embeddings
  async findSemanticMatch(userMessage) {
    try {
      console.log(`🧠 Creating embedding for: "${userMessage}"`);
      
      const queryResponse = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userMessage
      });
      const queryEmbedding = queryResponse.data[0].embedding;

      console.log('🧠 Loading all documents for semantic comparison...');
      const docs = await getDocs(query(collection(this.db, 'chatbot_data'), limit(5000)));
      
      let bestMatch = null;
      let bestSimilarity = 0;
      let checkedCount = 0;
      let hasEmbeddingCount = 0;

      docs.forEach(doc => {
        const data = doc.data();
        checkedCount++;
        
        if (!data.embedding) {
          return; // Skip documents without embeddings
        }
        hasEmbeddingCount++;

        const similarity = this.cosineSimilarity(queryEmbedding, data.embedding);
        
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          
          // Handle different question formats for originalQuestion
          let originalQuestion;
          if (Array.isArray(data.questions)) {
            originalQuestion = data.questions[0];
          } else if (typeof data.questions === 'string') {
            originalQuestion = data.questions.split(',')[0].trim();
          } else {
            originalQuestion = data.questions || 'Unknown question';
          }
          
          bestMatch = {
            answer: data.answer,
            category: data.category || 'general',
            originalQuestion: originalQuestion,
            docId: doc.id,
            similarity: similarity
          };
        }
      });

      console.log(`🧠 Checked ${checkedCount} docs, ${hasEmbeddingCount} had embeddings, best similarity: ${bestSimilarity.toFixed(3)}`);

      if (bestSimilarity >= 0.80) { // Higher threshold for semantic match
        return {
          found: true,
          answer: bestMatch.answer,
          category: bestMatch.category,
          originalQuestion: bestMatch.originalQuestion,
          docId: bestMatch.docId,
          similarity: bestSimilarity,
          confidence: bestSimilarity,
          matchType: 'semantic'
        };
      }

      return {
        found: false,
        answer: '',
        category: 'no_match',
        similarity: bestSimilarity,
        confidence: bestSimilarity,
        matchType: 'insufficient_semantic'
      };

    } catch (error) {
      console.error('❌ Error in findSemanticMatch:', error);
      return {
        found: false,
        answer: '',
        category: 'error',
        similarity: 0,
        confidence: 0,
        matchType: 'semantic_error'
      };
    }
  }

  // 🧮 Calculate cosine similarity between two vectors
  cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
    const queryWords = this.normalizeText(query).split(' ').filter(word => word.length > 0);
    const targetWords = this.normalizeText(target).split(' ').filter(word => word.length > 0);
    
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
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const chatbot = new FirestoreChatbot();
    const result = await chatbot.handleRequest(userMessage, userId, lang);

    res.status(200).json(result);

  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      response: '',
      confidence: 0,
      category: 'error'
    });
  }
}
