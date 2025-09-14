// 🔥 api/chatbot.js - Hybrid: Firebase for basic search + PostgreSQL for embeddings
// Firebase handles high traffic, PostgreSQL only for semantic search

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, addDoc, limit } from 'firebase/firestore';
import pkg from 'pg';
const { Client } = pkg;
import OpenAI from 'openai';

// Firebase config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase
let app;
let db;
if (!app) {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
}

class HybridChatbot {
  constructor() {
    this.db = db;
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.pgClient = null;
  }

  // 🔗 Connect to PostgreSQL only for semantic search
  async connectPostgreSQL() {
    if (this.pgClient && !this.pgClient._ending) {
      return this.pgClient;
    }

    // Validate required environment variables
    if (!process.env.POSTGRES_HOST || !process.env.POSTGRES_PASSWORD) {
      throw new Error('Missing required PostgreSQL environment variables');
    }

    const dbConfig = {
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT) || 5432,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: false,
      connectionTimeoutMillis: 10000,
    };

    this.pgClient = new Client(dbConfig);
    await this.pgClient.connect();
    console.log('✅ Connected to PostgreSQL for semantic search');
    return this.pgClient;
  }

  // 🎯 Main endpoint handler
  async handleRequest(userMessage, userId = 'anonymous', lang = 'vi') {
    try {
      console.log('📨 Received request:', { userMessage, userId });
      
      if (!userMessage || userMessage.trim() === '') {
        return {
          success: false,
          error: 'No message provided',
          response: "Vui lòng nhập câu hỏi của bạn",
          confidence: 0,
          category: "error"
        };
      }

      // BƯỚC 1: Thử EXACT MATCH với Firebase (nhanh, không tốn bandwidth nhiều)
      console.log('🔥 === STEP 1: Firebase EXACT MATCH ===');
      const exactResponse = await this.findExactMatchFirebase(userMessage);
      
      if (exactResponse.found) {
        console.log('✅ EXACT MATCH found in Firebase');
        await this.logQueryFirebase(userMessage, exactResponse, userId);
        
        return {
          success: true,
          response: exactResponse.answer,
          confidence: 1.0,
          category: exactResponse.category,
          matched_question: exactResponse.originalQuestion,
          match_type: 'exact',
          similarity: 1.0,
          source: 'firebase',
          timestamp: new Date().toISOString()
        };
      }

      // BƯỚC 2: Thử SIMILARITY MATCH với Firebase (vẫn nhanh)
      console.log('🔥 === STEP 2: Firebase SIMILARITY MATCH ===');
      const similarityResponse = await this.findSimilarityMatchFirebase(userMessage);
      
      if (similarityResponse.found) {
        console.log(`✅ SIMILARITY MATCH found in Firebase - Confidence: ${similarityResponse.confidence}`);
        await this.logQueryFirebase(userMessage, similarityResponse, userId);
        
        return {
          success: true,
          response: similarityResponse.answer,
          confidence: similarityResponse.confidence,
          similarity: similarityResponse.similarity,
          category: similarityResponse.category,
          matched_question: similarityResponse.originalQuestion,
          match_type: 'similarity',
          source: 'firebase',
          timestamp: new Date().toISOString()
        };
      }

      // BƯỚC 3: Chỉ khi không tìm thấy mới dùng PostgreSQL SEMANTIC SEARCH
      console.log('🧠 === STEP 3: PostgreSQL SEMANTIC MATCH ===');
      const semanticResponse = await this.findSemanticMatchPostgres(userMessage);

      if (semanticResponse.found) {
        console.log(`✅ SEMANTIC MATCH found in PostgreSQL - Confidence: ${semanticResponse.confidence}`);
        await this.logQueryFirebase(userMessage, semanticResponse, userId);
        
        return {
          success: true,
          response: semanticResponse.answer,
          confidence: semanticResponse.confidence,
          similarity: semanticResponse.similarity,
          category: semanticResponse.category,
          matched_question: semanticResponse.originalQuestion,
          match_type: 'semantic',
          source: 'postgresql',
          timestamp: new Date().toISOString()
        };
      }

      // Không tìm thấy gì
      console.log(`❌ NO MATCH found for: "${userMessage}"`);
      return {
        success: false,
        response: `Xin lỗi, tôi không tìm thấy câu trả lời phù hợp cho câu hỏi "${userMessage}". Bạn có thể thử hỏi một cách khác không?`,
        confidence: 0,
        category: 'no_match',
        match_type: 'none',
        source: 'none'
      };

    } catch (error) {
      console.error('❌ Error in handleRequest:', error);
      return {
        success: false,
        error: error.toString(),
        response: `Lỗi hệ thống: ${error.message}`,
        confidence: 0,
        category: "error"
      };
    } finally {
      // Close PostgreSQL connection if opened
      if (this.pgClient && !this.pgClient._ending) {
        try {
          await this.pgClient.end();
          this.pgClient = null;
        } catch (err) {
          console.error('Error closing PostgreSQL connection:', err);
        }
      }
    }
  }

  // 🔥 Find exact match in Firebase
  async findExactMatchFirebase(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      
      const q = query(
        collection(this.db, 'chatbot_data'),
        where('normalized_questions', 'array-contains', normalizedMessage),
        limit(1)
      );

      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0];
        const data = doc.data();
        
        let originalQuestion = Array.isArray(data.questions) 
          ? data.questions[0] 
          : data.questions;
        
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

      return { found: false };
    } catch (error) {
      console.error('❌ Error in findExactMatchFirebase:', error);
      return { found: false };
    }
  }

  // 🔥 Find similarity match in Firebase
  async findSimilarityMatchFirebase(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      const messageWords = normalizedMessage.split(' ').filter(word => word.length > 1);
      
      if (messageWords.length === 0) return { found: false };

      const q = query(
        collection(this.db, 'chatbot_data'),
        where('keywords', 'array-contains-any', messageWords),
        limit(50)
      );

      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) return { found: false };

      let bestMatch = null;
      let bestSimilarity = 0;

      querySnapshot.docs.forEach(doc => {
        const data = doc.data();
        
        let questionsArray = Array.isArray(data.questions) 
          ? data.questions 
          : [data.questions];

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

      if (confidence >= 0.8 && bestMatch) {
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
      }

      return { found: false, similarity: bestSimilarity, confidence: confidence };
    } catch (error) {
      console.error('❌ Error in findSimilarityMatchFirebase:', error);
      return { found: false };
    }
  }

  // 🧠 Find semantic match in PostgreSQL (chỉ khi cần thiết)
  async findSemanticMatchPostgres(userMessage) {
    try {
      console.log('🧠 Creating embedding for semantic search...');
      
      // Create embedding
      const queryResponse = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userMessage
      });

      const queryEmbedding = queryResponse.data[0].embedding;
      
      // Connect to PostgreSQL
      const client = await this.connectPostgreSQL();
      
      // Semantic search with pgvector
      const query = `
        SELECT 
          id, 
          questions, 
          answer, 
          category,
          1 - (embedding <=> $1) as similarity
        FROM documents 
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1
        LIMIT 3
      `;

      const embeddingVector = `[${queryEmbedding.join(',')}]`;
      const result = await client.query(query, [embeddingVector]);

      if (result.rows.length > 0) {
        const bestMatch = result.rows[0];
        
        if (bestMatch.similarity >= 0.8) {
          const originalQuestion = Array.isArray(bestMatch.questions) 
            ? bestMatch.questions[0] 
            : bestMatch.questions;
          
          return {
            found: true,
            answer: bestMatch.answer,
            category: bestMatch.category || 'general',
            originalQuestion: originalQuestion,
            docId: bestMatch.id,
            similarity: bestMatch.similarity,
            confidence: bestMatch.similarity,
            matchType: 'semantic'
          };
        }
      }

      return {
        found: false,
        similarity: result.rows.length > 0 ? result.rows[0].similarity : 0,
        confidence: 0
      };

    } catch (error) {
      console.error('❌ Error in findSemanticMatchPostgres:', error);
      return { found: false, confidence: 0, similarity: 0 };
    }
  }

  // 📊 Log to Firebase (cheaper than PostgreSQL)
  async logQueryFirebase(userMessage, response, userId) {
    try {
      const logData = {
        timestamp: new Date(),
        userMessage: userMessage,
        botAnswer: response.answer,
        confidence: response.confidence || 1.0,
        category: response.category,
        userId: userId,
        matchType: response.matchType || 'exact',
        similarity: response.similarity || 1.0,
        source: response.source || 'firebase'
      };

      await addDoc(collection(this.db, 'query_analytics'), logData);
    } catch (error) {
      console.error('Error logging query to Firebase:', error);
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
    
    return union.size === 0 ? 0 : intersection.size / union.size;
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

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    let userMessage, userId, lang;

    if (req.method === 'GET') {
      userMessage = req.query.q || req.query.message || '';
      userId = req.query.userId || req.query.user_id || 'anonymous';
      lang = req.query.lang || 'vi';
    } else if (req.method === 'POST') {
      userMessage = req.body.message || req.body.q || '';
      userId = req.body.userId || req.body.user_id || 'anonymous';
      lang = req.body.lang || 'vi';
    } else {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const chatbot = new HybridChatbot();
    const result = await chatbot.handleRequest(userMessage, userId, lang);

    res.status(200).json(result);

  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      response: `Lỗi API: ${error.message}`,
      confidence: 0,
      category: 'error'
    });
  }
}
