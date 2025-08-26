// 🔥 api/chatbot.js - Vercel API Route with Simple Word Matching
// Phương pháp đơn giản: So sánh từng từ thay vì Jaccard similarity

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, addDoc, limit, query } from 'firebase/firestore';

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

      // Tìm kiếm với logic đơn giản
      console.log('🔍 === SEARCHING WITH SIMPLE WORD MATCH ===');
      const searchResponse = await this.findBestMatch(userMessage);
      
      if (searchResponse.found) {
        console.log(`✅ MATCH found - Type: ${searchResponse.matchType}, Confidence: ${searchResponse.confidence}`);
        await this.logQuery(userMessage, searchResponse, userId);
        
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
        console.log(`❌ NO MATCH found for: "${userMessage}"`);
        
        return {
          success: false,
          response: '',
          confidence: searchResponse.confidence || 0,
          similarity: searchResponse.similarity || 0,
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

  // 🔍 Tìm kiếm với logic đơn giản - giống Google Sheets
  async findBestMatch(userMessage) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 Original: "${userMessage}"`);
      console.log(`🔍 Normalized: "${normalizedMessage}"`);

      // Lấy tất cả documents từ Firebase
      const q = query(collection(this.db, 'chatbot_data'), limit(1000));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        console.log('❌ No documents found in Firebase');
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
      let bestScore = 0;
      let bestMatchType = 'none';

      // Duyệt qua từng document
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        
        // Kiểm tra structure của document
        if (!data.questions || !Array.isArray(data.questions) || !data.answer) {
          console.log(`⚠️ Document ${doc.id} has invalid structure`);
          continue;
        }

        console.log(`\n📄 Checking document ${doc.id}:`);
        console.log(`Questions: ${JSON.stringify(data.questions)}`);

        // Kiểm tra từng question trong document
        for (let i = 0; i < data.questions.length; i++) {
          const question = data.questions[i];
          if (!question || typeof question !== 'string') continue;

          console.log(`\n  Question ${i + 1}: "${question}"`);

          // Split keywords nếu có dấu phẩy
          const questionKeywords = question.split(',').map(q => q.trim());
          console.log(`  Keywords: [${questionKeywords.map(k => `"${k}"`).join(', ')}]`);
          
          for (let j = 0; j < questionKeywords.length; j++) {
            const keyword = questionKeywords[j];
            const normalizedKeyword = this.normalizeText(keyword);
            
            console.log(`\n    Keyword ${j + 1}: "${keyword}"`);
            console.log(`    Normalized: "${normalizedKeyword}"`);
            console.log(`    Compare: "${normalizedMessage}" vs "${normalizedKeyword}"`);

            // 1. EXACT MATCH - Ưu tiên cao nhất
            if (normalizedMessage === normalizedKeyword) {
              console.log(`🎯 EXACT MATCH FOUND!`);
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

            // 2. WORD ORDER MATCH - "chào xin" vs "xin chào"
            const score = this.calculateWordOrderMatch(normalizedMessage, normalizedKeyword);
            console.log(`    Word order score: ${score.toFixed(3)}`);

            if (score > bestScore) {
              bestScore = score;
              bestMatch = {
                answer: data.answer,
                category: data.category || 'general',
                originalQuestion: keyword,
                docId: doc.id,
                similarity: score
              };
              bestMatchType = score === 1.0 ? 'perfect_words' : 'partial_words';
              console.log(`    🔥 NEW BEST MATCH: ${score.toFixed(3)}`);
            }
          }
        }
      }

      // Xác định confidence
      const confidence = this.getConfidenceFromScore(bestScore);
      
      console.log(`\n🎯 FINAL RESULTS:`);
      console.log(`Best score: ${bestScore.toFixed(3)}`);
      console.log(`Confidence: ${confidence}`);
      console.log(`Match type: ${bestMatchType}`);

      // Chấp nhận từ 0.7 trở lên (70% match)
      if (confidence >= 0.75 && bestMatch) {
        console.log(`✅ MATCH ACCEPTED!`);
        console.log(`📝 Matched: "${bestMatch.originalQuestion}"`);
        console.log(`🤖 Answer: "${bestMatch.answer}"`);
        
        return {
          found: true,
          answer: bestMatch.answer,
          category: bestMatch.category,
          originalQuestion: bestMatch.originalQuestion,
          docId: bestMatch.docId,
          similarity: bestScore,
          confidence: confidence,
          matchType: bestMatchType
        };
      } else {
        console.log(`❌ NO SUFFICIENT MATCH (best: ${bestScore.toFixed(3)}, confidence: ${confidence})`);
        
        return {
          found: false,
          answer: '',
          category: 'no_match',
          similarity: bestScore,
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

  // 🧮 SIMPLE: Tính điểm dựa trên từ giống nhau (thay thế Jaccard)
  calculateWordOrderMatch(query, target) {
    const queryWords = query.split(' ').filter(word => word.length > 0);
    const targetWords = target.split(' ').filter(word => word.length > 0);
    
    console.log(`      Query words: [${queryWords.join(', ')}]`);
    console.log(`      Target words: [${targetWords.join(', ')}]`);

    if (queryWords.length === 0 || targetWords.length === 0) {
      return 0;
    }

    // Đếm số từ giống nhau
    let matchedWords = 0;
    const targetWordSet = new Set(targetWords);
    
    for (const queryWord of queryWords) {
      if (targetWordSet.has(queryWord)) {
        matchedWords++;
      }
    }

    console.log(`      Matched words: ${matchedWords}`);
    console.log(`      Total query words: ${queryWords.length}`);
    console.log(`      Total target words: ${targetWords.length}`);

    // Cách tính đơn giản: matched_words / max(query_length, target_length)
    const maxLength = Math.max(queryWords.length, targetWords.length);
    const score = matchedWords / maxLength;

    // Bonus nếu tất cả từ đều match và độ dài gần bằng nhau
    if (matchedWords === queryWords.length && matchedWords === targetWords.length) {
      console.log(`      🎯 Perfect word match!`);
      return 1.0;
    }

    console.log(`      Final score: ${score.toFixed(3)}`);
    return score;
  }

  // 🎯 Chuyển đổi score thành confidence
  getConfidenceFromScore(score) {
    if (score >= 1.0) {
      return 1.0; // Perfect match
    } else if (score >= 0.9) {
      return 0.95; // Excellent match
    } else if (score >= 0.8) {
      return 0.85; // Good match  
    } else if (score >= 0.7) {
      return 0.75; // Acceptable match
    } else {
      return score; // Low match
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
