const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const LINKS_FILE = 'tum_linkler.json';
const OUTPUT_FILE = 'colyak_listesi.json';

async function scrapeDetails() {
  if (!fs.existsSync(LINKS_FILE)) {
    console.error(`${LINKS_FILE} bulunamadı!`);
    return;
  }

  const allUrls = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf-8'));
  let savedData = [];

  // Mevcut ilerlemeyi yükle
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      savedData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    } catch (e) {
      savedData = [];
    }
  }

  // Daha önce çekilmiş URL'leri Set ile yakala
  const processedUrls = new Set(savedData.map(item => item.url));
  const remainingUrls = allUrls.filter(url => !processedUrls.has(url));

  console.log(`Toplam Link: ${allUrls.length}`);
  console.log(`Zaten Çekilen: ${processedUrls.size}`);
  console.log(`Kalan İşlenecek: ${remainingUrls.length}`);

  if (remainingUrls.length === 0) {
    console.log('Tüm ürünler zaten çekilmiş!');
    return;
  }

  let counter = 0;

  for (const url of remainingUrls) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 7000
      });

      const $ = cheerio.load(response.data);
      
      // Sitedeki başlık ve içerik alanlarına göre düzenle
      const title = $('h1').text().trim() || $('title').text().trim();
      const bodyText = $('body').text();
      const isGlutenFree = bodyText.includes('Glutensiz') || bodyText.includes('gluten içermez');

      savedData.push({
        url: url,
        title: title,
        glutenFree: isGlutenFree,
        scrapedAt: new Date().toISOString()
      });

      counter++;
      console.log(`[${processedUrls.size + counter}/${allUrls.length}] Çekildi: ${title}`);

      // Her 20 üründe bir dosyayı diske kaydet
      if (counter % 20 === 0) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(savedData, null, 2), 'utf-8');
      }

      // Güvenlik beklemesi (1.5 saniye)
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.error(`Hata (${url}): ${err.message}`);
    }
  }

  // İşlem bitince son hali kaydet
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(savedData, null, 2), 'utf-8');
  console.log('Oturum tamamlandı.');
}

scrapeDetails();
