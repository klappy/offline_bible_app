var express = require('express');
var router = express.Router();
var request = require('request');
var async = require('async');
var _ = require('lodash');
var xlsx = require('xlsx-writestream');
var fs = require ('fs');
var s3 = require('s3');

//Models
var Bible = require('../models/bible');
var Book =  require('../models/book');
var Chapter =  require('../models/chapter');
var Verse = require('../models/verse');

// Export xls
router.route('/bibles/:bible_id/books/:book_id/chapters/:chapter_id/xlsx').post(function(req, res){

    bibleId = req.params.bible_id;
    chapterId = req.params.chapter_id;
    bookId = req.params.book_id;
    sourceLanguage = req.body.srcLang;
    targetLanguage = req.body.trgLang;
    resJson = {};
    var resFlag = 0;
    var verseStr = []; var bookMetakeys = [];

    var iterateChapters = function (chapt, callback) {
    
       var tmpRes = {};
	    if (chapterId == chapt.chapter) {
	      //console.log('chapt is ' + chapt);
        Verse.find({chapterId:chapt._id}).exec(function (verseErr, verseDocs) {
		    //console.log('verse is ' + verseDocs);
		
          verses = _.pluck(verseDocs, 'verse');
		      //console.log('the verses are ' + verses);

          verses.forEach(function(oneVerse){
				    verseStr.push(oneVerse);
          });
			
          generateSuggestions(verseStr, req.body.srcLang, req.body.trgLang, function(suggestionErr, suggestionRes) {
            if (suggestionErr) { return callback(suggestionErr); }

            generateXls(suggestionRes,bookMetakeys, function(xlsxErr, xlsxRes) {
              if (xlsxErr) { return callback(xlsxErr); }

              uploadXls(xlsxRes, function(uploadErr, uploadRes) {
                if (uploadErr) { return callback(uploadErr); }
                return callback(null, uploadRes);
                
              });

            });

          });
        });

      } else {
          callback(null, 'false');
      }
    };
    
    Bible
	.findOne({'bibleId':bibleId})
	.populate('books')
    .exec(function (err, selBible) {
	    if (err) {
		    return res.status(500).json({
		      message: "Error processing request. " + err
		    });
	    }
	    if (!selBible) {
		    return res.status(404).json({
		      message: "Could not find Bible with the given name. " + err
		    });
	    }
	    selBible.books.forEach(function (book) {
		    if (book.bookName == bookId) {
		      Book.findById(book._id)
			     .populate('chapters')
			     .exec(function (bookErr, bookDoc) {
			       //console.log('first it is' + bookDoc);
             
            var metaData = JSON.parse(bookDoc.metadata);
            metaData.forEach(function(oneValue){
              //console.log(JSON.stringify(oneValue));
              var arr = JSON.stringify(oneValue).split(":");
              //console.log(arr[0].replace("{","").replace(/"/g, ""));
              verseStr.push(arr[0].replace("{","").replace(/"/g, ""));
              var tmpType = {};
              tmpType['Type'] = arr[1].replace("}","").replace(/"/g, "");
              bookMetakeys.push(tmpType);
             
            });

             async.map(bookDoc.chapters, iterateChapters, function (err, results) {
              //console.log(results);
                if(err) {
                  res.status(500).json({
                      message: "Could not export the chapter. " + err
                  });
                } else {

                  for(var i = 0; i < results.length; i++) {
                    if (results[i] != 'false') {
                      resFlag = 1;
                      res.status(200).json({url : results[i]});
                    }
                  }
                          
                  if (resFlag == 0) {
                    res.status(404).json({
                      message: "Could not found the chapter. " + err
                    });
                  }
                }

             });
			     });
		    }
	    });
	});

    // return res.status(200).json("File Created on your local and uloaded too!");
});


generateSuggestions = function(sourceData, sourceLang, targetLang, callback) {
  var options = {
    url: process.env.ALCHEMY_HOST + '/text-batch',
    qs: { texts: JSON.stringify(sourceData), from: sourceLang, to: targetLang, customer: process.env.ALCHEMY_CUSTOMER, token: process.env.ALCHEMY_AUTH_TOKEN, project: process.env.SE_PROJECT, asset: process.env.SE_ASSET }
  };
  //console.log(options);
  request.get(options, function(alchemyErr, alchemyRes, alchemyBody) {
    if (alchemyErr) { return callback(alchemyErr); }

    var suggestions = []

    for (var i = 0; i < sourceData.length; i++) {
      suggestions.push({ source: sourceData[i], suggestion: JSON.parse(alchemyBody)[i] });
    }

    return callback(null, suggestions);
  });
}

generateXls = function(sourceData, metaKeys, callback) {

	console.log("Inside generateXls function"); var num = 1; var finalDta = [];
 
  var filename = bookId + '_chapter_' + chapterId + '_' + sourceLanguage + '_to_' + targetLanguage + '.xlsx';
	
  for( var i = 0; i < sourceData.length; i++) {
      if(metaKeys[i]!= null) {
        var target = _.extend(metaKeys[i], sourceData[i]);
        finalDta.push(target);
      } else {
        var verseNum = {};
        verseNum['Type'] = num;
        var target = _.extend(verseNum, sourceData[i]);
        num++;
        finalDta.push(target);
      }
  }
  
  xlsx.write(filename, finalDta, function (err) {
	    if(err) {return callback(null, err);}
	});
	
  return callback(null, filename);
}

uploadXls = function(filename, callback) {
  
	var client = s3.createClient({
    maxAsyncS3: 20,     // this is the default 
    s3RetryCount: 3,    // this is the default 
    s3RetryDelay: 1000, // this is the default 
    multipartUploadThreshold: 20971520, // this is the default (20 MB) 
    multipartUploadSize: 15728640, // this is the default (15 MB) 
    s3Options: {
      accessKeyId: process.env.S3_KEY,
      secretAccessKey: process.env.S3_SECRET
      // any other options are passed to new AWS.S3() 
      // See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#constructor-property 
    }
  });

  var prefixLoc = process.env.AWS_HOST + '/' + process.env.S3_BUCKET + '/' + process.env.AWS_ENV + '/' + sourceLanguage + '/' + bookId + '/chapter_' + chapterId + '/' + filename;
  var s3BucketKey = process.env.AWS_ENV + '/' + sourceLanguage + '/' + bookId + '/chapter_' + chapterId + '/' + filename;
  console.log(s3BucketKey);
  var params = {
    localFile: filename,
 
    s3Params: {
      Bucket: process.env.S3_BUCKET,
      Key: s3BucketKey,
      ACL:'public-read'
      // other options supported by putObject, except Body and ContentLength. 
      // See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property 
    }
  };


  var uploader = client.uploadFile(params);
  
  uploader.on('error', function(err) {
    console.error("unable to upload:", err.stack);
  });
  uploader.on('progress', function() {
    console.log("progress", uploader.progressMd5Amount,
      uploader.progressAmount, uploader.progressTotal);
  });
  uploader.on('end', function() {
   console.log("done uploading");
  });

  return callback(null, prefixLoc);
}
// Return router
module.exports = router;
