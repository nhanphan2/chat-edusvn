// test-postgres-connection.js
// Script để test kết nối PostgreSQL và verify data

import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

dotenv.config();

async function testConnection() {
  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl: false
  });

  try {
    console.log('🔗 Connecting to PostgreSQL...');
    await client.connect();
    console.log('✅ Connected successfully!');

    // Test 1: Count documents
    const countResult = await client.query('SELECT COUNT(*) FROM documents');
    console.log(`📊 Total documents: ${countResult.rows[0].count}`);

    // Test 2: Count with embeddings
    const embeddingResult = await client.query('SELECT COUNT(*) FROM documents WHERE embedding IS NOT NULL');
    console.log(`🧠 Documents with embeddings: ${embeddingResult.rows[0].count}`);

    // Test 3: Sample documents
    const sampleResult = await client.query(`
      SELECT 
        id, 
        questions[1] as first_question, 
        category,
        CASE 
          WHEN embedding IS NOT NULL THEN 'Yes'
          ELSE 'No'
        END as has_embedding
      FROM documents 
      ORDER BY id 
      LIMIT 5
    `);

    console.log('\n📝 Sample documents:');
    sampleResult.rows.forEach((row, idx) => {
      console.log(`${idx + 1}. ID: ${row.id}`);
      console.log(`   Question: "${row.first_question?.substring(0, 60)}..."`);
      console.log(`   Category: ${row.category}`);
      console.log(`   Has Embedding: ${row.has_embedding}\n`);
    });

    // Test 4: Vector similarity test
    console.log('🧠 Testing vector similarity...');
    const vectorTest = await client.query(`
      SELECT 
        1 - (embedding <=> embedding) as self_similarity
      FROM documents 
      WHERE embedding IS NOT NULL 
      LIMIT 1
    `);
    
    if (vectorTest.rows.length > 0) {
      console.log(`✅ pgvector working! Self-similarity: ${vectorTest.rows[0].self_similarity}`);
    }

    console.log('\n🎉 All tests passed! Database is ready.');

  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  } finally {
    await client.end();
  }
}

testConnection();
