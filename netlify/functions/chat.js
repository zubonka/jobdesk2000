exports.handler = async function (event, context) {
  // 1. Дозволяємо тільки POST-запити
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 2. Отримуємо повідомлення від користувача з фронтенду
    const body = JSON.parse(event.body);
    const userMessage = body.message;

    // 3. Дістаємо твій секретний ключ з налаштувань Netlify
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: "Ключ API не знайдено в налаштуваннях" }) 
      };
    }

    // 4. Відправляємо запит до Gemini API
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: userMessage
          }]
        }]
      })
    });

    const data = await geminiResponse.json();

    // 5. Повертаємо відповідь від Gemini назад на твій сайт
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error("Помилка:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Не вдалося обробити запит" })
    };
  }
};
