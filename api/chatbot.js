// 🔥 FIRESTORE CHATBOT BACKEND
// Thay thế hoàn toàn Google Apps Script + Google Sheets
// Deploy lên Vercel/Netlify/Firebase Functions

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, addDoc, orderBy, limit } from 'firebase/firestore';

// Firebase config
const firebaseConfig = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "your-app-id"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 📊 COLLECTIONS STRUCTURE:
// 1. chatbot_data: {id, questions[], answer, category, keywords[]}
// 2. query_analytics: {timestamp, userMessage, botAnswer, confidence, userId, etc.}

class FirestoreChatbot {
  constructor() {
    this.db = db;
  }

  // 🎯 Main endpoint - GET/POST handler
  async handleRequest(userMessage, userId = 'anonymous', lang = 'vi') {
    try {
      console.log('📨 Received request:', { userMessage, userId, lang });
      
      if (!userMessage) {
        return this.createResponse({
          success: false,
          error: 'No message provided',
          response: "Vui lòng nhập câu hỏi của bạn",
          confidence: 0,
          category: "error"
        });
      }

      // BƯỚC 1: Thử EXACT MATCH
      console.log('🎯 === STEP 1: Trying EXACT MATCH ===');
      const exactResponse = await this.findExactMatch(userMessage);
      
      if (exactResponse.found) {
        console.log('✅ EXACT MATCH found');
        await this.logQuery(userMessage, exactResponse, userId);
        
        return this.createResponse({
          success: true,
          response: exactResponse.answer,
          confidence: 1.0,
          category: exactResponse.category,
          matched_question: exactResponse.originalQuestion,
          match_type: 'exact',
          similarity: 1.0,
          timestamp: new Date().toISOString()
        });
      }

      // BƯỚC 2: Thử SIMILARITY MATCH
      console.log('🔍 === STEP 2: Trying SIMILARITY MATCH ===');
      const similarityResponse = await this.findSimilarityMatch(userMessage);
      
      if (similarityResponse.found) {
        console.log(`✅ SIMILARITY MATCH found - Confidence: ${similarityResponse.confidence}`);
        await this.logQuery(userMessage, similarityResponse, userId);
        
        return this.createResponse({
          success: true,
          response: similarityResponse.answer,
          confidence: similarityResponse.confidence,
          similarity: similarityResponse.similarity,
          category: similarityResponse.category,
          matched_question: similarityResponse.originalQuestion,
          match_type: 'similarity',
          timestamp: new Date().toISOString()
        });
      } else {
        console.log(`❌ NO MATCH found for: "${userMessage}"`);
        
        return this.createResponse({
          success: false,
          response: '',
          confidence: similarityResponse.confidence || 0,
          similarity: similarityResponse.similarity || 0,
          category: 'no_match',
          match_type: 'none',
          message: 'No sufficient match found'
        });
      }

    } catch (error) {
      console.error('❌ Error in handleRequest:', error);
      return this.createResponse({
        success: false,
        error: error.toString(),
        response: '',
        confidence: 0,
        category: "error"
      });
    }
  }

  // 🎯 Find exact match in Firestore
  async findExactMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 Searching for exact match: "${normalizedMessage}"`);

      // Query Firestore với array-contains-any
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
        console.log(`📝 Answer: "${data.answer}"`);
        
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

      console.log(`❌ NO EXACT MATCH found`);
      return {
        found: false,
        answer: '',
        category: 'no_match',
        originalQuestion: '',
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
      
      console.log(`🔍 Searching for similarity match with words: [${messageWords.join(', ')}]`);

      // Query với keywords overlap
      const q = query(
        collection(this.db, 'chatbot_data'),
        where('keywords', 'array-contains-any', messageWords),
        limit(50) // Lấy nhiều để tính similarity
      );

      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        console.log('❌ No documents found with matching keywords');
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

      // Tính similarity cho từng document
      querySnapshot.docs.forEach(doc => {
        const data = doc.data();
        
        // Tính similarity với từng question
        data.questions.forEach(question => {
          const similarity = this.calculateSimilarity(normalizedMessage, question);
          
          console.log(`📝 "${question}" - Similarity: ${similarity.toFixed(3)}`);
          
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
        console.log(`❌ NO SUFFICIENT SIMILARITY MATCH`);
        
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
        responseTime: Math.random() * 2, // Simulate response time
        userRating: null,
        userId: userId,
        matchType: response.matchType || 'exact',
        similarity: response.similarity || 1.0,
        docId: response.docId || null
      };

      await addDoc(collection(this.db, 'query_analytics'), logData);
      
      console.log(`📊 Logged ${response.matchType} match query to analytics`);
      
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

  // 🔧 Create response
  createResponse(data) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: JSON.stringify(data)
    };
  }
}

// 📡 VERCEL/NETLIFY API ENDPOINTS

// GET endpoint
export async function GET(request) {
  const url = new URL(request.url);
  const userMessage = url.searchParams.get('q') || url.searchParams.get('message') || '';
  const userId = url.searchParams.get('userId') || url.searchParams.get('user_id') || 'anonymous';
  const lang = url.searchParams.get('lang') || 'vi';

  const chatbot = new FirestoreChatbot();
  return chatbot.handleRequest(userMessage, userId, lang);
}

// POST endpoint
export async function POST(request) {
  const data = await request.json();
  const userMessage = data.message || data.q || '';
  const userId = data.userId || data.user_id || 'anonymous';

  const chatbot = new FirestoreChatbot();
  return chatbot.handleRequest(userMessage, userId);
}

// =================================================================
// 🚀 MIGRATION SCRIPT - Convert Google Sheets to Firestore
// =================================================================

class DataMigration {
  constructor() {
    this.db = db;
  }

  // Migrate từ Google Sheets data sang Firestore
  async migrateFromGoogleSheets(sheetsData) {
    console.log('🚀 Starting migration to Firestore...');
    
    const batch = [];
    
    for (let i = 1; i < sheetsData.length; i++) { // Skip header
      const [questionCell, answer, category] = sheetsData[i];
      
      if (!questionCell || !answer) continue;
      
      // Split questions/keywords
      const questions = questionCell.split(',').map(q => q.trim());
      
      // Create normalized questions for exact match
      const normalizedQuestions = questions.map(q => this.normalizeText(q));
      
      // Extract keywords for similarity search
      const keywords = [...new Set([
        ...questions.flatMap(q => q.split(' ')),
        ...normalizedQuestions.flatMap(q => q.split(' '))
      ])].filter(word => word.length > 1);
      
      const docData = {
        questions: questions,
        normalized_questions: normalizedQuestions,
        answer: answer,
        category: category || 'general',
        keywords: keywords,
        created_at: new Date(),
        updated_at: new Date()
      };
      
      batch.push(docData);
      
      // Batch upload mỗi 500 documents
      if (batch.length >= 500) {
        await this.uploadBatch(batch);
        batch.length = 0; // Clear array
      }
    }
    
    // Upload remaining documents
    if (batch.length > 0) {
      await this.uploadBatch(batch);
    }
    
    console.log('✅ Migration completed!');
  }
  
  async uploadBatch(batch) {
    console.log(`📤 Uploading batch of ${batch.length} documents...`);
    
    const promises = batch.map(docData => 
      addDoc(collection(this.db, 'chatbot_data'), docData)
    );
    
    await Promise.all(promises);
    console.log(`✅ Batch uploaded successfully`);
  }
  
  normalizeText(text) {
    // Same normalize function as above
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

// Usage: Migrate data
// const migration = new DataMigration();
// await migration.migrateFromGoogleSheets(googleSheetsData);
