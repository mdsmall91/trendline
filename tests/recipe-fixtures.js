'use strict';

/* =============================================================
   TRENDLINE — RECIPE FIXTURES

   Real JSON-LD, pulled from four live recipe pages on 2026-09-05 and
   pruned of the parts the parser never reads (instructions, ingredient
   lists, comments, reviews) so the file stays legible.

   The STRUCTURE is untouched, and that matters more than the size:

     budgetbytes    the Recipe is the eighth node of an @graph, behind
                    an Article, a WebPage, an ImageObject and four more
     allrecipes     a bare top-level array
     cookieandkate  spells @type "nutritionInformation", small n, and
                    yields "2 cups (8 servings)" — two, meaning eight
     seriouseats    states its serving count in prose on servingSize

   Every one of those is a way a reasonable parser fails on a page that
   plainly has the data. That is why these are saved from real sites
   rather than written to match the spec.
   ============================================================= */

var RECIPE_FIXTURES = {
  "budgetbytes.com": {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#article",
        "headline": "Easy Slow Cooker Chicken Tikka Masala",
        "datePublished": "2018-09-13T16:56:17+00:00",
        "dateModified": "2025-05-07T10:39:05+00:00",
        "image": {
          "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#primaryimage"
        },
        "inLanguage": "en-US"
      },
      {
        "@type": "WebPage",
        "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/",
        "url": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/",
        "name": "Easy Slow Cooker Chicken Tikka Masala - Budget Bytes",
        "primaryImageOfPage": {
          "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#primaryimage"
        },
        "image": {
          "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#primaryimage"
        },
        "datePublished": "2018-09-13T16:56:17+00:00",
        "dateModified": "2025-05-07T10:39:05+00:00",
        "inLanguage": "en-US"
      },
      {
        "@type": "ImageObject",
        "inLanguage": "en-US",
        "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#primaryimage",
        "url": "https://www.budgetbytes.com/wp-content/uploads/201…",
        "contentUrl": "https://www.budgetbytes.com/wp-content/uploads/201…",
        "width": 800,
        "height": 600,
        "caption": "This Slow Cooker Chicken Tikka Masala boasts a ric…"
      },
      {
        "@type": "BreadcrumbList",
        "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#breadcrumb"
      },
      {
        "@type": "WebSite",
        "@id": "https://www.budgetbytes.com/#website",
        "url": "https://www.budgetbytes.com/",
        "name": "Budget Bytes",
        "inLanguage": "en-US"
      },
      {
        "@type": "Organization",
        "@id": "https://www.budgetbytes.com/#organization",
        "name": "Budget Bytes",
        "url": "https://www.budgetbytes.com/",
        "image": {
          "@id": "https://www.budgetbytes.com/#/schema/logo/image/"
        }
      },
      {
        "@type": "Person",
        "@id": "https://www.budgetbytes.com/#/schema/person/de533a4dad507aefcf8ea04e131701f9",
        "name": "Beth Moncel",
        "image": {
          "@type": "ImageObject",
          "inLanguage": "en-US",
          "@id": "https://secure.gravatar.com/avatar/ba1bd0462fb679d…",
          "url": "https://secure.gravatar.com/avatar/ba1bd0462fb679d…",
          "contentUrl": "https://secure.gravatar.com/avatar/ba1bd0462fb679d…",
          "caption": "Beth Moncel"
        },
        "url": "https://www.budgetbytes.com/author/beth/"
      },
      {
        "@type": "Recipe",
        "name": "Slow Cooker Chicken Tikka Masala",
        "datePublished": "2018-09-13T11:56:17+00:00",
        "image": [
          "https://www.budgetbytes.com/wp-content/uploads/201…",
          "https://www.budgetbytes.com/wp-content/uploads/201…",
          "https://www.budgetbytes.com/wp-content/uploads/201…",
          "https://www.budgetbytes.com/wp-content/uploads/201…"
        ],
        "recipeYield": [
          "6"
        ],
        "prepTime": "PT15M",
        "cookTime": "PT195M",
        "totalTime": "PT210M",
        "nutrition": {
          "@type": "NutritionInformation",
          "servingSize": "1 Serving",
          "calories": "415.88 kcal",
          "carbohydrateContent": "37.03 g",
          "proteinContent": "34.17 g",
          "fatContent": "13.95 g",
          "fiberContent": "2.12 g",
          "sodiumContent": "978.77 mg"
        },
        "@id": "https://www.budgetbytes.com/slow-cooker-chicken-tikka-masala/#recipe"
      }
    ]
  },
  "allrecipes.com": [
    {
      "@context": "http://schema.org",
      "@type": [
        "Recipe",
        "NewsArticle"
      ],
      "headline": "Chicken Parmesan",
      "datePublished": "2012-06-06T16:20:12-04:00",
      "dateModified": "2026-07-20T17:10:18-04:00",
      "image": {
        "@type": "ImageObject",
        "url": "https://www.allrecipes.com/thmb/J0U0wHxsY1r-I1JUJ5…",
        "height": 1125,
        "width": 1500
      },
      "name": "Chicken Parmesan",
      "cookTime": "PT20M",
      "nutrition": {
        "@type": "NutritionInformation",
        "calories": "471 kcal",
        "carbohydrateContent": "25 g",
        "cholesterolContent": "187 mg",
        "fiberContent": "1 g",
        "proteinContent": "42 g",
        "saturatedFatContent": "9 g",
        "sodiumContent": "840 mg",
        "sugarContent": "2 g",
        "fatContent": "25 g",
        "unsaturatedFatContent": "0 g"
      },
      "prepTime": "PT15M",
      "recipeYield": "4",
      "totalTime": "PT45M"
    }
  ],
  "cookieandkate.com": {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": "https://cookieandkate.com/best-hummus-recipe/#article",
        "headline": "The Best Hummus",
        "datePublished": "2018-05-23T19:50:14+00:00",
        "dateModified": "2024-08-29T20:33:56+00:00",
        "image": {
          "@id": "https://cookieandkate.com/best-hummus-recipe/#primaryimage"
        },
        "inLanguage": "en-US"
      },
      {
        "@type": "WebPage",
        "@id": "https://cookieandkate.com/best-hummus-recipe/",
        "url": "https://cookieandkate.com/best-hummus-recipe/",
        "name": "Best Hummus Recipe (Plus Tips & Variations) - Cookie and Kate",
        "primaryImageOfPage": {
          "@id": "https://cookieandkate.com/best-hummus-recipe/#primaryimage"
        },
        "image": {
          "@id": "https://cookieandkate.com/best-hummus-recipe/#primaryimage"
        },
        "datePublished": "2018-05-23T19:50:14+00:00",
        "dateModified": "2024-08-29T20:33:56+00:00",
        "inLanguage": "en-US"
      },
      {
        "@type": "ImageObject",
        "inLanguage": "en-US",
        "@id": "https://cookieandkate.com/best-hummus-recipe/#primaryimage",
        "url": "https://cookieandkate.com/images/2018/05/best-hummus-recipe-6.jpg",
        "contentUrl": "https://cookieandkate.com/images/2018/05/best-hummus-recipe-6.jpg",
        "width": 1100,
        "height": 1648,
        "caption": "best hummus recipe"
      },
      {
        "@type": "BreadcrumbList",
        "@id": "https://cookieandkate.com/best-hummus-recipe/#breadcrumb"
      },
      {
        "@type": "WebSite",
        "@id": "https://cookieandkate.com/#website",
        "url": "https://cookieandkate.com/",
        "name": "Cookie and Kate",
        "inLanguage": "en-US"
      },
      {
        "@type": "Organization",
        "@id": "https://cookieandkate.com/#organization",
        "name": "Cookie and Kate",
        "url": "https://cookieandkate.com/",
        "image": {
          "@id": "https://cookieandkate.com/#/schema/logo/image/"
        }
      },
      {
        "@type": "Person",
        "@id": "https://cookieandkate.com/#/schema/person/c609c24a34a1976d0a3c1a1b0cd7f46a",
        "name": "Kathryne Taylor",
        "image": {
          "@type": "ImageObject",
          "inLanguage": "en-US",
          "@id": "https://cookieandkate.com/images/2024/10/cropped-kathryne-taylor-200-96x96.jpg",
          "url": "https://cookieandkate.com/images/2024/10/cropped-kathryne-taylor-200-96x96.jpg",
          "contentUrl": "https://cookieandkate.com/images/2024/10/cropped-kathryne-taylor-200-96x96.jpg",
          "caption": "Kathryne Taylor"
        }
      },
      {
        "@context": "https://schema.org/",
        "@type": "Recipe",
        "name": "Best Hummus",
        "image": [
          "https://cookieandkate.com/images/2018/05/best-hummus-225x225.jpg",
          "https://cookieandkate.com/images/2018/05/best-hummus-260x195.jpg",
          "https://cookieandkate.com/images/2018/05/best-hummus-320x180.jpg",
          "https://cookieandkate.com/images/2018/05/best-hummus.jpg"
        ],
        "url": "https://cookieandkate.com/best-hummus-recipe/",
        "prepTime": "PT20M",
        "cookTime": "PT20M",
        "totalTime": "PT40M",
        "recipeYield": [
          "2",
          "2 cups (8 servings)"
        ],
        "cookingMethod": "Food processor",
        "nutrition": {
          "servingSize": "1/4 cup",
          "calories": "151 calories",
          "sugarContent": "1.5 g",
          "sodiumContent": "217.4 mg",
          "fatContent": "10.6 g",
          "saturatedFatContent": "1.5 g",
          "transFatContent": "0 g",
          "carbohydrateContent": "11.1 g",
          "fiberContent": "3.4 g",
          "proteinContent": "4.9 g",
          "cholesterolContent": "0 mg",
          "@type": "nutritionInformation"
        },
        "datePublished": "2018-05-23",
        "@id": "https://cookieandkate.com/best-hummus-recipe/#recipe"
      }
    ]
  },
  "seriouseats.com": [
    {
      "@context": "http://schema.org",
      "@type": [
        "Recipe"
      ],
      "headline": "Perfect Pan-Seared Steaks Recipe",
      "datePublished": "2011-03-18T04:30:00-04:00",
      "dateModified": "2025-02-11T19:51:07-05:00",
      "image": {
        "@type": "ImageObject",
        "url": "https://www.seriouseats.com/thmb/UPKVxYzimkDIG3CCV…",
        "height": 1500,
        "width": 1125
      },
      "name": "Perfect Pan-Seared Steaks Recipe",
      "cookTime": "PT20M",
      "nutrition": {
        "@type": "NutritionInformation",
        "calories": "1149 kcal",
        "carbohydrateContent": "0 g",
        "cholesterolContent": "296 mg",
        "fiberContent": "0 g",
        "proteinContent": "84 g",
        "saturatedFatContent": "37 g",
        "sodiumContent": "764 mg",
        "sugarContent": "0 g",
        "fatContent": "91 g",
        "servingSize": "Serves at least 2",
        "unsaturatedFatContent": "0 g"
      },
      "prepTime": "PT5M",
      "recipeYield": "2",
      "totalTime": "PT70M"
    }
  ]
};

if (typeof module !== 'undefined' && module.exports) module.exports = RECIPE_FIXTURES;
