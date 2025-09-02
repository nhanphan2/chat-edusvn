// 🔥 api/chatbot.js - Vercel API Route with PostgreSQL + pgvector
// Thay thế Firebase + Supabase bằng PostgreSQL trên DigitalOcean

import pkg from 'pg';
const { Client } = pkg;
import OpenAI from 'openai';

class PostgresChatbot {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.pgClient = null;
  }

  // 🔗 Connect to PostgreSQL
  async connectDB() {
    if (this.pgClient && !this.pgClient._ending) {
      return this.pgClient;
    }

    this.pgClient = new Client({
      host: process.env.POSTGRES_HOST, 
      port: process.env.POSTGRES_PORT,
      database: process.env.POSTGRES_DB, 
      user: process.env.POSTGRES_USER,    
      password: process.env.POSTGRES_PASSWORD,
      ssl: false,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });

    try {
      await this.pgClient.connect();
      console.log('✅ Connected to PostgreSQL');
      return this.pgClient;
    } catch (error) {
      console.error('❌ PostgreSQL connection failed:', error);
      throw error;
    }
  }

  // 🎯 Main endpoint handler
  async handleRequest(userMessage, userId = 'anonymous', lang = 'vi') {
    let client = null;
    
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

      // Connect to database
      client = await this.connectDB();

      // BƯỚC 1: Thử EXACT MATCH
      console.log('🎯 === STEP 1: Trying EXACT MATCH ===');
      const exactResponse = await this.findExactMatch(userMessage, client);
      
      if (exactResponse.found) {
        console.log('✅ EXACT MATCH found');
        await this.logQuery(userMessage, exactResponse, userId, client);
        
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
      const similarityResponse = await this.findSimilarityMatch(userMessage, client);
      
      if (similarityResponse.found) {
        console.log(`✅ SIMILARITY MATCH found - Confidence: ${similarityResponse.confidence}`);
        await this.logQuery(userMessage, similarityResponse, userId, client);
        
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

      // BƯỚC 3: Thử SEMANTIC MATCH với pgvector
      console.log('🧠 === STEP 3: Trying SEMANTIC MATCH ===');
      const semanticResponse = await this.findSemanticMatch(userMessage, client);

      if (semanticResponse.found) {
        console.log(`✅ SEMANTIC MATCH found - Confidence: ${semanticResponse.confidence}`);
        await this.logQuery(userMessage, semanticResponse, userId, client);
        
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
    } finally {
      // Close connection
      if (client && !client._ending) {
        try {
          await client.end();
        } catch (err) {
          console.error('Error closing PostgreSQL connection:', err);
        }
      }
    }
  }

  // 🎯 Find exact match in PostgreSQL
  async findExactMatch(userMessage, client) {
    try {
      const normalizedMessage = this.normalizeText(userMessage);
      console.log(`🔍 Searching for exact match: "${normalizedMessage}"`);

      const query = `
        SELECT id, questions, normalized_questions, answer, category
        FROM documents 
        WHERE $1 = ANY(normalized_questions)
        LIMIT 1
      `;

      const result = await client.query(query, [normalizedMessage]);
      
      if (result.rows.length > 0) {
        const doc = result.rows[0];
        
        console.log('✅ EXACT MATCH FOUND!');
        
        // Get first question
        const originalQuestion = Array.isArray(doc.questions) 
          ? doc.questions[0] 
          : doc.questions;
        
        return {
          found: true,
          answer: doc.answer,
          category: doc.category || 'general',
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

  // 🔍 Find similarity match in PostgreSQL
  async findSimilarityMatch(userMessage, client) {
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

      // Search by keywords overlap
      const query = `
        SELECT id, questions, answer, category, keywords
        FROM documents 
        WHERE keywords && $1
        ORDER BY (
          SELECT COUNT(*) 
          FROM unnest(keywords) keyword 
          WHERE keyword = ANY($1)
        ) DESC
        LIMIT 50
      `;

      const result = await client.query(query, [messageWords]);
      
      if (result.rows.length === 0) {
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

      result.rows.forEach(doc => {
        // Get questions array
        let questionsArray = [];
        if (Array.isArray(doc.questions)) {
          questionsArray = doc.questions;
        } else if (typeof doc.questions === 'string') {
          questionsArray = [doc.questions];
        }

        questionsArray.forEach(question => {
          if (!question) return;
          
          const similarity = this.calculateSimilarity(normalizedMessage, question);
          
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestMatch = {
              answer: doc.answer,
              category: doc.category || 'general',
              originalQuestion: question,
              docId: doc.id,
              similarity: similarity
            };
          }
        });
      });

      const confidence = this.getConfidenceLevel(bestSimilarity);

      if (confidence >= 0.75 && bestMatch) {
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

  // 🧠 Find semantic match using pgvector
  async findSemanticMatch(userMessage, client) {
    try {
      console.log(`🧠 Creating embedding for: "${userMessage}"`);
      
      // Create embedding with OpenAI
      const queryResponse = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userMessage
      });

      const queryEmbedding = queryResponse.data[0].embedding;
      console.log('🧠 Querying PostgreSQL for semantic matches...');
      
      // Use pgvector for similarity search
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
        LIMIT 5
      `;

      // Convert embedding to PostgreSQL vector format
      const embeddingVector = `[${queryEmbedding.join(',')}]`;
      const result = await client.query(query, [embeddingVector]);

      if (result.rows.length > 0) {
        const bestMatch = result.rows[0];
        
        if (bestMatch.similarity >= 0.75) {
          console.log(`✅ SEMANTIC MATCH found - Similarity: ${bestMatch.similarity.toFixed(3)}`);
          
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

      console.log('❌ No semantic match found in PostgreSQL');
      return {
        found: false,
        answer: '',
        category: 'no_match',
        similarity: result.rows.length > 0 ? result.rows[0].similarity : 0,
        confidence: 0,
        matchType: 'insufficient_semantic'
      };

    } catch (error) {
      console.error('❌ Error in findSemanticMatch:', error);
      return {
        found: false,
        answer: '',
        category: 'no_match',
        similarity: 0,
        confidence: 0,
        matchType: 'semantic_error'
      };
    }
  }

  // 📊 Log query analytics to PostgreSQL
  async logQuery(userMessage, response, userId, client) {
    try {
      const query = `
        INSERT INTO query_analytics (
          user_message, bot_answer, confidence, category, 
          user_id, match_type, similarity, doc_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `;

      const values = [
        userMessage,
        response.answer,
        response.confidence || 1.0,
        response.category,
        userId,
        response.matchType || 'exact',
        response.similarity || 1.0,
        response.docId || null,
        new Date()
      ];

      await client.query(query, values);
      
    } catch (error) {
      console.error('Error logging query:', error);
      // Don't throw error, just log it
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

    const chatbot = new PostgresChatbot();
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
