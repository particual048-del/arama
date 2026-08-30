const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { execSync } = require('child_process');

// Dosya Yolları
const DATA_FILE = path.join(__dirname, 'colyak_listesi.json');
const URLS_FILE = path.join(__dirname, 'tum_linkler.json');

// Bu workflow dosyasının adı (yeni run'u otomatik tetiklemek için gerekli)
const WORKFLOW_FILE = 'scraper.yml';

// Her batch'te işlenecek maksimum ürün sayısı
const BATCH_LIMIT = 2000;

// Batch'ler arasında verilecek mola süresi (siteyi yormamak için)
const BATCH_PAUSE_MS = 10 * 60 * 1000; // 10 dakika

// Bir GitHub Actions çalıştırmasının kullanabileceği güvenli süre bütçesi
// (gerçek sınır 6 saat; olası gecikmeler için pay bırakıyoruz)
const RUN_TIME_BUDGET_MS = 5.5 * 60 * 60 * 1000; // 5.5 saat

// Üst üste kaç kez engellenirse çalışmayı durduracağız
// (artık üstel bekleme olduğu için daha toleranslı olabiliriz)
const MAX_CONSECUTIVE_BLOCKS = 5;

// Engel yendiğinde bekleme süresi üstel olarak artar (10s, 20s, 40s, 80s, sonra 90s'de sabitlenir)
const BLOCK_BACKOFF_BASE_MS = 10000;
const BLOCK_BACKOFF_MAX_MS = 90000;

// Kaç üründe bir, siteyi daha "insansı" yormak için ekstra uzun bir mola verilecek
const HUMAN_PAUSE_EVERY = 150;
const HUMAN_PAUSE_MIN_MS = 30000;
const HUMAN_PAUSE_MAX_MS = 60000;

// Engellenmeyi önlemek için dinamik User-Agent listesi (masaüstü + mobil karışık)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
];

// Gerçekçi görünmesi için birden fazla olası referrer
const REFERERS = [
  'https://www.google.com/',
  'https://www.google.com.tr/',
  'https://www.bing.com/',
  'https://www.google.com/search?q=urun+ara'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomReferer() {
  return REFERERS[Math.floor(Math.random() * REFERERS.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min = 1200, max = 2000) => Math.floor(Math.random() * (max - min + 1)) + min;

// GitHub'a Commit & Push yapan fonksiyon (Çakışma önleyicili)
function commitAndPush(count) {
  try {
    console.log(`\n>>> [OTOMATİK PUSH] ${count} ürün JSON veritabanına işlendi, GitHub'a push atılıyor...`);
    execSync('git config --global user.name "github-actions[bot]"');
    execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');

    // Değişiklikleri stage et ve önce yerel commit'i oluştur
    execSync('git add colyak_listesi.json');
    execSync(`git commit -m "chore: ${count} urun veritabanina eklendi [auto push]" || true`);

    // Uzak depoda yeni commit varsa, kendi commit'imiz zaten yapıldığı için
    // güvenle rebase ile üstüne taşıyabiliriz
    try {
      execSync('git pull origin main --rebase');
    } catch (e) {
      console.log('>>> [GIT PULL INFO] Rebase adımı geçildi veya gerekmedi.');
    }

    const token = process.env.GH_TOKEN;
    const repo = process.env.RENDER_GIT_REPO_SLUG || process.env.GITHUB_REPOSITORY;

    if (token && repo) {
      execSync(`git push https://${token}@github.com/${repo}.git HEAD:main`);
    } else {
      execSync('git push');
    }

    console.log('>>> [OTOMATİK PUSH] İşlem başarılı. colyak_listesi.json güncellendi.\n');
  } catch (error) {
    console.log(`>>> [PUSH UYARISI] Push atlanıyor/güncel: ${error.message}`);
  }
}

// Süre bütçesi dolduğunda (veya kalıcı engel durumunda) bir sonraki çalıştırmayı
// hemen tetikler, böylece bir sonraki cron'u (6 saat) beklemeye gerek kalmaz.
// GH_TOKEN'in bu isteği atabilmesi için "Actions: write" (fine-grained) ya da
// "workflow"/"repo" (classic) yetkisine sahip olması gerekir.
async function triggerNextRun(reason) {
  const token = process.env.GH_TOKEN;
  const repo = process.env.RENDER_GIT_REPO_SLUG || process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF_NAME || 'main';

  if (!token || !repo) {
    console.log('>>> [OTOMATİK DEVAM] GH_TOKEN/REPO bilgisi yok, yeni run tetiklenemedi. Bir sonraki zamanlanmış çalıştırma bekleniyor.');
    return;
  }

  try {
    await axios.post(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        timeout: 15000
      }
    );
    console.log(`>>> [OTOMATİK DEVAM] (${reason}) Kalan linkler için yeni bir çalıştırma tetiklendi.`);
  } catch (err) {
    const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    console.log(`>>> [OTOMATİK DEVAM UYARISI] Yeni run tetiklenemedi (${detail}). Bir sonraki zamanlanmış çalıştırma bekleniyor.`);
  }
}

// Sayfa içeriğinde erişim engeli veya Captcha kontrolü
function isBlockedContent(html) {
  if (!html) return false;
  const lowerHtml = html.toLowerCase();
  const blockKeywords = [
    'cf-browser-verification',
    'g-recaptcha',
    'access denied',
    '403 forbidden',
    'too many requests',
    'just a moment...',
    'enable javascript and cookies'
  ];
  return blockKeywords.some(keyword => lowerHtml.includes(keyword));
}

let consecutiveBlockCount = 0;

function getBlockBackoffMs() {
  const backoff = BLOCK_BACKOFF_BASE_MS * Math.pow(2, Math.max(consecutiveBlockCount - 1, 0));
  return Math.min(backoff, BLOCK_BACKOFF_MAX_MS);
}

// İstek Atma ve Engel Algılama
async function fetchWithBlockCheck(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Referer': getRandomReferer()
      },
      timeout: 10000
    });

    if (isBlockedContent(response.data)) {
      consecutiveBlockCount++;
      console.warn(`\n⚠️ [ERİŞİM ENGELİ LOGU] Captcha/Bloklama algılandı! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS}) -> Link: ${url}`);
      return { data: null, isBlocked: true };
    }

    consecutiveBlockCount = 0;
    return { data: response.data, isBlocked: false };

  } catch (err) {
    const status = err.response ? err.response.status : null;

    if (status === 429 || status === 403) {
      consecutiveBlockCount++;
      console.warn(`\n⚠️ [ERİŞİM ENGELİ LOGU] HTTP Status ${status} hatası! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS}) -> Link: ${url}`);
      return { data: null, isBlocked: true };
    }

    console.error(`\n❌ [BAĞLANTI HATASI LOGU] (${url}): ${err.message}`);
    return { data: null, isBlocked: false };
  }
}

// Metinden veya URL'den Barkod (EAN-13 / GTIN) Çıkarma Fonksiyonu
function extractBarcode(text, url) {
  const barcodeRegex = /\b869\d{10}\b|\b\d{13}\b/;
  const matchInUrl = url.match(barcodeRegex);
  if (matchInUrl) return matchInUrl[0];

  const matchInText = text.match(barcodeRegex);
  if (matchInText) return matchInText[0];

  return null;
}

// Kaynak sayfadan gelen başlığı temizler:
// - Sondaki literal "\N" (kaynak sitenin veritabanı dökümünden kalan) ifadesini siler
// - Gerçek satır sonu karakterlerini boşluğa çevirir
// - Sonda tekrar eden "(barkod)" kısmını siler (barkod zaten ayrı alanda tutuluyor)
// - Fazla boşlukları sadeleştirir
function cleanTitle(rawTitle) {
  let cleaned = rawTitle || '';

  cleaned = cleaned.replace(/\\[nN]+/g, ' ');       // literal "\n" / "\N" dizileri
  cleaned = cleaned.replace(/[\r\n]+/g, ' ');        // gerçek satır sonları
  cleaned = cleaned.replace(/\s*\(\s*\d{8,14}\s*\)\s*$/, ''); // sondaki "(barkod)"
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return cleaned || 'Bilinmeyen Ürün';
}

// Tek bir batch'i (en fazla BATCH_LIMIT ürün) işler, savedData'yı günceller
// ve o batch'te kaç yeni ürün eklendiğini döndürür.
// runStartedAt: süre bütçesini batch ORTASINDA da kontrol edebilmek için gerekli
// (böylece 6 saatlik GitHub Actions sınırı hiçbir zaman zorla aşılmaz).
async function processBatch(remainingUrls, allUrlsLength, savedData, runStartedAt) {
  const processedCountAtStart = allUrlsLength - remainingUrls.length;
  const targetBatch = Math.min(remainingUrls.length, BATCH_LIMIT);
  let newlyAddedCount = 0;
  let timeBudgetExceededMidBatch = false;

  for (let i = 0; i < targetBatch; i++) {
    // Süre bütçesi batch'in ortasında dolarsa, mevcut ürünleri koruyup temiz şekilde çık
    if (Date.now() - runStartedAt >= RUN_TIME_BUDGET_MS) {
      console.log('\n⏱ [SÜRE SINIRI] Bütçe batch ortasında doldu, mevcut ilerleme kaydedilip bu batch sonlandırılıyor.');
      timeBudgetExceededMidBatch = true;
      break;
    }

    const url = remainingUrls[i];
    const currentIndex = processedCountAtStart + newlyAddedCount + 1;

    // Üst üste çok sayıda engel alınırsa: veriyi kaydet, push'la, yeni bir run
    // tetikle (taze bir runner = taze IP ile devam eder) ve HATASIZ şekilde çık.
    if (consecutiveBlockCount >= MAX_CONSECUTIVE_BLOCKS) {
      console.error(`\n🚨 [KRİTİK ENGEL DURUMU] Üst üste ${MAX_CONSECUTIVE_BLOCKS} kez erişim engeli alındı. İşlem güvenli şekilde durduruluyor.`);
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
      await triggerNextRun('üst üste engel');
      console.log('\n[ÇALIŞTIRMA TAMAMLANDI] (engel nedeniyle erken bitti, yeni run tetiklendi)');
      process.exit(0);
    }

    const { data: html, isBlocked } = await fetchWithBlockCheck(url);

    if (isBlocked) {
      const backoffMs = getBlockBackoffMs();
      console.warn(`>>> [BEKLEME] Engel sonrası ${Math.round(backoffMs / 1000)} sn bekleniyor...`);
      await sleep(backoffMs);
      continue;
    }

    if (!html) continue;

    const $ = cheerio.load(html);
    const rawTitle = $('h1').text().trim() || 'Bilinmeyen Ürün';
    const title = cleanTitle(rawTitle);
    const rawBodyText = $('body').text();

    // Türkçe karakter uyumlu küçük harf dönüştürme
    const pageText = rawBodyText.toLocaleLowerCase('tr-TR');
    const pageTitle = title.toLocaleLowerCase('tr-TR');

    // Gluten durumu kontrolü
    const isGlutenFree = pageText.includes('glutensiz') ||
                         pageTitle.includes('glutensiz') ||
                         pageText.includes('gluten içermez') ||
                         pageText.includes('gluten icermez') ||
                         pageText.includes('gluten-free');

    // Barkod tespiti
    const barcode = extractBarcode(rawBodyText, url);

    // JSON Veritabanı Eleman Yapısı
    const productData = {
      barcode: barcode,
      title: title,
      glutenFree: isGlutenFree,
      url: url,
      scrapedAt: new Date().toISOString()
    };

    savedData.push(productData);
    newlyAddedCount++;

    // Konsola Canlı Bilgi Basma
    console.log(`[${currentIndex}/${allUrlsLength}] Çekildi | Ürün: "${title}" | Barkod: ${barcode || 'Bulunamadı'} | Glutensiz: ${isGlutenFree}`);

    // Her 20 üründe bir yerele yaz
    if (newlyAddedCount % 20 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
    }

    // Her 200 üründe bir dosyaya yaz ve GitHub'a push at
    if (newlyAddedCount % 200 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
    }

    // Her HUMAN_PAUSE_EVERY üründe bir, insan gibi görünmek için ekstra uzun mola
    if (newlyAddedCount % HUMAN_PAUSE_EVERY === 0) {
      const humanPauseMs = Math.floor(Math.random() * (HUMAN_PAUSE_MAX_MS - HUMAN_PAUSE_MIN_MS + 1)) + HUMAN_PAUSE_MIN_MS;
      console.log(`>>> [DOĞAL MOLA] ${Math.round(humanPauseMs / 1000)} sn ara veriliyor...`);
      await sleep(humanPauseMs);
    } else {
      await sleep(getRandomDelay());
    }
  }

  return { newlyAddedCount, timeBudgetExceededMidBatch };
}

async function scrape() {
  const runStartedAt = Date.now();
  let savedData = [];

  try {
    // Mevcut veritabanı dosyasını okuyarak kaldığı yerden devam etmesini sağla
    if (fs.existsSync(DATA_FILE)) {
      try {
        const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
        savedData = JSON.parse(fileContent);
      } catch (e) {
        savedData = [];
      }
    }

    if (!fs.existsSync(URLS_FILE)) {
      console.error(`[KRİTİK HATA] ${URLS_FILE} dosyası bulunamadı!`);
      process.exit(1);
    }

    const allUrls = JSON.parse(fs.readFileSync(URLS_FILE, 'utf-8'));

    let batchNumber = 0;

    while (true) {
      const processedUrls = new Set(savedData.map(item => item.url));
      const remainingUrls = allUrls.filter(url => !processedUrls.has(url));

      if (remainingUrls.length === 0) {
        console.log('\nTüm ürünler taranmış! İşlem bitti.');
        break;
      }

      const elapsed = Date.now() - runStartedAt;
      if (elapsed >= RUN_TIME_BUDGET_MS) {
        console.log(`\n⏱ [SÜRE SINIRI] Güvenli çalışma süresi (${(RUN_TIME_BUDGET_MS / 3600000).toFixed(1)} saat) doldu. Kalan ${remainingUrls.length} link için yeni bir çalıştırma tetikleniyor.`);
        await triggerNextRun('süre bütçesi doldu');
        break;
      }

      batchNumber++;
      console.log(`\n===================== BATCH ${batchNumber} =====================`);
      console.log(`Toplam Link Sayısı    : ${allUrls.length}`);
      console.log(`Veritabanındaki Ürün  : ${processedUrls.size}`);
      console.log(`Kalan İşlenecek Link  : ${remainingUrls.length}`);
      console.log(`Bu Batch'te İşlenecek : ${Math.min(remainingUrls.length, BATCH_LIMIT)}`);
      console.log(`===============================================================\n`);

      const { newlyAddedCount, timeBudgetExceededMidBatch } = await processBatch(remainingUrls, allUrls.length, savedData, runStartedAt);

      // Batch sonunda kaydet ve GitHub'a push at
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
      console.log(`\n[BATCH ${batchNumber} TAMAMLANDI] Bu batch'te ${newlyAddedCount} yeni ürün eklendi.`);

      const remainingAfter = allUrls.length - savedData.length;
      if (remainingAfter <= 0) {
        console.log('\nTüm ürünler taranmış! İşlem bitti.');
        break;
      }

      if (timeBudgetExceededMidBatch) {
        console.log(`\n⏱ [SÜRE SINIRI] Batch ortasında bütçe dolduğu için yeni bir çalıştırma tetikleniyor. Kalan ${remainingAfter} link.`);
        await triggerNextRun('süre bütçesi batch ortasında doldu');
        break;
      }

      const elapsedAfter = Date.now() - runStartedAt;
      if (elapsedAfter + BATCH_PAUSE_MS >= RUN_TIME_BUDGET_MS) {
        console.log(`\n⏱ [SÜRE SINIRI] Mola sonrası süre bütçesi aşılacağı için yeni bir çalıştırma tetikleniyor. Kalan ${remainingAfter} link.`);
        await triggerNextRun('mola sonrası bütçe yetmiyor');
        break;
      }

      console.log(`\n💤 [MOLA] Bir sonraki batch'ten önce ${BATCH_PAUSE_MS / 60000} dakika bekleniyor...`);
      await sleep(BATCH_PAUSE_MS);
    }
  } catch (err) {
    // Beklenmeyen herhangi bir hata: veriyi kaydetmeyi dene, yeni run tetikle,
    // ama run'ı ASLA "failed" durumda bırakma.
    console.error(`\n❌ [BEKLENMEYEN HATA] ${err.message}`);
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
    } catch (innerErr) {
      console.error(`>>> [KAYIT HATASI] ${innerErr.message}`);
    }
    await triggerNextRun('beklenmeyen hata sonrası kurtarma');
  }

  console.log('\n[ÇALIŞTIRMA TAMAMLANDI]');
}

scrape();
