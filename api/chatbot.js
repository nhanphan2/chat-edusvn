// 🔥 api/chatbot.js - Vercel API Route
// Thay thế hoàn toàn Google Apps Script + Google Sheets

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, addDoc, limit } from 'firebase/firestore';

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
      } else {
        console.log(`❌ NO MATCH found for: "${userMessage}"`);
        
        return {
          success: false,
          response: '',
          confidence: similarityResponse.confidence || 0,
          similarity: similarityResponse.similarity || 0,
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

  // 🎯 Find exact match in Firestore - Copy logic từ Google Sheets
async findExactMatch(userMessage) {
 try {
   const normalizedMessage = this.normalizeText(userMessage);
   console.log(`🔍 Searching for EXACT MATCH: "${userMessage}"`);
   console.log(`🧹 Normalized query: "${normalizedMessage}"`);

   // Lấy TẤT CẢ documents (như Google Sheets duyệt tất cả rows)
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

   // Duyệt qua tất cả documents (giống Google Sheets duyệt từng row)
   let docIndex = 0;
   for (const doc of querySnapshot.docs) {
     docIndex++;
     const data = doc.data();
     
     if (!data.questions || !Array.isArray(data.questions) || !data.answer) {
       console.log(`⚠️ Document ${docIndex} missing questions or answer`);
       continue;
     }

     // Duyệt từng question trong document
     for (const question of data.questions) {
       if (!question) continue;

       // Split keywords trong Question (nếu có dấu phẩy) - giống Google Sheets
       const questionKeywords = question.split(',').map(q => q.trim());
       
       // Kiểm tra exact match với từng keyword
       for (const keyword of questionKeywords) {
         const normalizedKeyword = this.normalizeText(keyword);
         
         console.log(`📝 Doc ${docIndex}: Checking "${keyword}" (normalized: "${normalizedKeyword}")`);
         
         // EXACT MATCH CHECK - giống y hệt Google Sheets
         if (normalizedMessage === normalizedKeyword) {
           console.log(`✅ EXACT MATCH FOUND in document ${docIndex}!`);
           console.log(`📝 Original keyword: "${keyword}"`);
           console.log(`🤖 Answer: "${data.answer}"`);
           
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
       }
     }
   }

   console.log(`❌ NO EXACT MATCH found for: "${userMessage}"`);
   
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

  // 🔍 FIXED: Find similarity match - duyệt toàn bộ như Google Sheets
async findSimilarityMatch(userMessage) {
  try {
    const normalizedMessage = this.normalizeText(userMessage);
    console.log(`🔍 Searching for similarity: "${normalizedMessage}"`);

    // Lấy TẤT CẢ documents (như Google Sheets)
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

    // Duyệt TẤT CẢ documents
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      
      if (!data.questions || !Array.isArray(data.questions)) return;

      // Duyệt từng question
      data.questions.forEach(question => {
        // Split keywords nếu có dấu phẩy (giống Google Sheets)
        const questionKeywords = question.split(',').map(q => q.trim());
        
        questionKeywords.forEach(keyword => {
          const similarity = this.calculateSimilarity(normalizedMessage, keyword);
          
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestMatch = {
              answer: data.answer,
              category: data.category || 'general',
              originalQuestion: keyword,
              docId: doc.id,
              similarity: similarity
            };
          }
        });
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
  const queryWords = this.normalizeText(query).split(' ').filter(word => word.length > 0);
  const targetWords = this.normalizeText(target).split(' ').filter(word => word.length > 0);
  
  console.log(`Comparing: "${query}" vs "${target}"`);
  console.log(`Query words: [${queryWords.join(', ')}]`);
  console.log(`Target words: [${targetWords.join(', ')}]`);
  
  const querySet = new Set(queryWords);
  const targetSet = new Set(targetWords);
  
  const intersection = new Set([...querySet].filter(x => targetSet.has(x)));
  const union = new Set([...querySet, ...targetSet]);
  
  console.log(`Intersection: [${[...intersection].join(', ')}] (${intersection.size})`);
  console.log(`Union: [${[...union].join(', ')}] (${union.size})`);
  
  if (union.size === 0) return 0;
  
  const similarity = intersection.size / union.size;
  console.log(`Similarity: ${similarity}`);
  
  return similarity;
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
