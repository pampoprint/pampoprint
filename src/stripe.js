import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import Stripe from 'stripe';
import {writeYamlFile} from './utils.js';
import {getProduct, getProductVariants, getProductPrice} from './products.js';
import site, {env} from './config.js';

const productsDir = path.join(process.cwd(), 'products');
const envSuffix = env === 'production' ? 'live' : 'test';
const stripeFileName = `stripe_${envSuffix}.yml`;
const stripeArchiveFolder = `stripe_archive_${envSuffix}`;

export function getStripeProductVariants(pk) {
  const filePath = path.join(productsDir, pk, stripeFileName);
  if (!fs.existsSync(filePath)) return {};

  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

export function saveStripeProductVariants(pk, data) {
  const filePath = path.join(productsDir, pk, stripeFileName);

  writeYamlFile(filePath, data);
}

export async function createStripePrice(stripeProductVariant, stripe, currency, unit_amount) {
  const stripePrice = await stripeRequest(() =>
    stripe.prices.create({
      currency: currency.toLowerCase(),
      unit_amount,
      product: stripeProductVariant.stripe_id,
    })
  );
  stripeProductVariant.stripe_prices[currency] = {id: stripePrice.id, unit_amount};
}

export function getArchivedPrices(pk, pvk) {
  const filePath = path.join(productsDir, pk, stripeArchiveFolder, `${pvk}.yml`);
  if (!fs.existsSync(filePath)) return {};

  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

export function saveArchivedPrices(pk, pvk, data) {
  const dir = path.join(productsDir, pk, stripeArchiveFolder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filePath = path.join(dir, `${pvk}.yml`);
  for (const currency in data) {
    data[currency].sort(comparePricesUnitAmountFn);
  }
  writeYamlFile(filePath, data);
}

function comparePricesUnitAmountFn(a, b) {
  return a.unit_amount - b.unit_amount;
}

export function searchArchivedPrice(sortedPrices, unitAmount) {
  let l = 0, r = sortedPrices.length - 1, m;
  while (l < r) {
    m = Math.floor((l + r) / 2);
    if (unitAmount <= sortedPrices[m].unit_amount) {
      r = m;
    } else {
      l = m + 1;
    }
  }
  if (sortedPrices.length && sortedPrices[r].unit_amount === unitAmount)
    return sortedPrices[r];
}

export async function updateAllStripeProductPrices() {
  const productDirs = fs.readdirSync(productsDir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const pk of productDirs) {
    console.log(`Updating Stripe prices for product: ${pk}`);
    await updateStripeProductPrices(pk);
  }
}

export async function updateStripeProductPrices(pk) {
  const product = getProduct(pk);
  const variants = getProductVariants(product);
  const stripeVariants = getStripeProductVariants(pk);
  const stripe = new Stripe(site.stripeApiSecretKey, {
    maxNetworkRetries: 3,
  });

  for (const pvk in variants) {
    const variant = variants[pvk];
    const colorImages = product.imagesByColor?.[variant.color];
    const varntImages = colorImages && colorImages.length ? colorImages : product.images;
    const data = {
      name: variant.name,
      images: varntImages.slice(0, 8).map((i) => `https://${site.domain}${i}`),
      statement_descriptor: site.company,
      url: `https://${site.domain}/products/${pk}.html`,
    };

    const stripeVariant = stripeVariants[pvk];
    if (stripeVariant) {
      console.log('Updating Stripe product variant:', stripeVariant);
      const stripeResponse = await stripeRequest(() =>
        stripe.products.update(stripeVariant.stripe_id, data)
      );
      console.log('Updated Stripe product variant:', stripeResponse.id);
      const archivedPrices = getArchivedPrices(pk, pvk);
      console.log('archivedPrices:', archivedPrices);

      for (const currency of site.supportedCurrencies) {
        const unit_amount = Math.round(getProductPrice(product, currency, variant.size) * 100);
        console.log(`PRODUCT PRICE: ${currency}:`, getProductPrice(product, currency, variant.size));
        console.log(`PRICE: ${currency} unit_amount:`, unit_amount);

        if (currency in stripeVariant.stripe_prices) {
          console.log('currency in stripeVariant.stripe_prices:', currency)
          console.log('stripeVariant.stripe_prices[currency]:', stripeVariant.stripe_prices[currency])
          const stripePrice = stripeVariant.stripe_prices[currency];

          if (stripePrice.unit_amount !== unit_amount) {
            archivedPrices[currency] ||= [];
            archivedPrices[currency].push(stripePrice);
            await stripeRequest(() =>
              stripe.prices.update(stripePrice.id, {active: false})
            );

            const matchedArchivedPrice = searchArchivedPrice(archivedPrices[currency] || [], unit_amount);
            if (matchedArchivedPrice) {
              await stripeRequest(() =>
                stripe.prices.update(matchedArchivedPrice.id, {active: true})
              );
              stripeVariant.stripe_prices[currency] = matchedArchivedPrice;
            } else {
              await createStripePrice(stripeVariant, stripe, currency, unit_amount);
            }
          }

        } else {
          await createStripePrice(stripeVariant, stripe, currency, unit_amount);
        }
      };

      saveArchivedPrices(pk, pvk, archivedPrices);

    } else {
      const productVariant = await stripeRequest(() =>
        stripe.products.create(data)
      );
      const pvData = {};
      if (variant.color) {
        pvData.color = variant.color;
      }
      if (variant.size) {
        pvData.size = variant.size;
      }
      pvData.stripe_id = productVariant.id;

      pvData.stripe_prices = {}
      for (const currency of site.supportedCurrencies) {
        const unit_amount = Math.round(getProductPrice(product, currency, variant.size) * 100);
        await createStripePrice(pvData, stripe, currency, unit_amount);
      };

      stripeVariants[pvk] = pvData;
    }
  };

  saveStripeProductVariants(pk, stripeVariants);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stripe rate limiter restricts the number of API requests per second as follows:
// production: 100 req/sec
// test: 25 req/sec
//
// production -> 15ms
// test -> 60ms
const STRIPE_RATE_LIMIT_DELAY = env === 'production' ? 15 : 60;

async function stripeRequest(fn, retries = 5) {
  let attempt = 0;

  while (true) {
    try {
      const result = await fn();

      // throttle between requests
      await sleep(STRIPE_RATE_LIMIT_DELAY);

      return result;

    } catch (err) {
      const isRateLimit =
        err?.type === 'StripeRateLimitError' ||
        err?.code === 'rate_limit' ||
        err?.statusCode === 429;

      if (!isRateLimit || attempt >= retries) {
        throw err;
      }

      const delay = 1000 * (attempt + 1);

      console.log(
        `Stripe rate limit exceeded. Retrying in ${delay}ms...`
      );

      await sleep(delay);

      attempt++;
    }
  }
}
