'use strict';
const path = require('path');
const electron = require('electron');
const { BrowserWindow, net, session } = electron;
const fs = require('fs');

const app = electron.app;
let downloadFolder = app.getPath('downloads');
let lastWindowCreated;

const queue = [];

const _popQueueItem = (url) => {
    let queueItem = queue.find(item => item.url === url);
    queue.splice(queue.indexOf(queueItem), 1);
    return queueItem;
};

 const _bytesToSize = (bytes,decimals) => {
    if(bytes == 0) return '0 Bytes';
    var k = 1000,
        dm = decimals || 2,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


 const _convertTime = (input, separator) => {
    var pad = function(input) {return input < 10 ? "0" + input : input;};
    return [
        pad(Math.floor(input / 3600)),
        pad(Math.floor(input % 3600 / 60)),
        pad(Math.floor(input % 60)),
    ].join(typeof separator !== 'undefined' ?  separator : ':' );
}

const _timeHumanReadable = (seconds) => {
    const minutes = seconds / (60);
    const hours = seconds / (60 * 60);
    const days = seconds / (60 * 60 * 24);
  
    if (seconds < 60) {
      return seconds.toFixed(1) + " Sec";
    } else if (minutes < 60) {
      return minutes.toFixed(1) + " Min";
    } else if (hours < 24) {
      return hours.toFixed(1) + " Hrs";
    } else {
      return days.toFixed(1) + " Days";
    }
}

const _movingAverageSpeed = (speedArr) => {
    let i;
  let averageSpeed = []
  for (i = 0; i < speedArr.length; i++) {
    if(i === 0){ 
        averageSpeed[0] = speedArr[0]
    }
    else if(i === 1){
        averageSpeed[i] = (speedArr[1] + speedArr[0])/2
    }
    else{
        const weight = 1/i;
        averageSpeed[i] = speedArr[i] * weight + averageSpeed[i-1] * (1 - weight)
    }
    }
    return averageSpeed.slice(-1).pop()
}

function _registerListener(win, opts = {}) {

    lastWindowCreated = win;
    downloadFolder = opts.downloadFolder || downloadFolder;

    const listener = (e, item) => {

        const itemUrl = decodeURIComponent(item.getURLChain()[0] || item.getURL())
        const itemFilename = decodeURIComponent(item.getFilename());

        let queueItem = _popQueueItem(itemUrl);
        let ReceivedBytesArr = [];

        if (queueItem) {
            const folder = queueItem.downloadFolder || downloadFolder
            const filePath = path.join(folder, queueItem.path, itemFilename);

                        const speedArr = []
                        let prevTotalReceivedByte = 0
                        let prevReceivedTime = new Date()
            const totalBytes = item.getTotalBytes();


            item.setSavePath(filePath);

            // Resuming an interrupted download
            if (item.getState() === 'interrupted') {
                item.resume();
            }

            item.on('updated', () => {
                            const currentTotalReceivedByte = item.getReceivedBytes()
                            const receivedByteChunk = currentTotalReceivedByte - prevTotalReceivedByte


                            if (typeof queueItem.onProgress === 'function' && currentTotalReceivedByte > 0 && currentTotalReceivedByte < totalBytes && receivedByteChunk > 0) {
                                const currentTime = new Date()
                                const timeLapsedInSec = (currentTime - prevReceivedTime)/1000
                                const speed = receivedByteChunk / timeLapsedInSec
                                speedArr.push(speed)
                                const averageSpeed =  _movingAverageSpeed(speedArr)   
                                const remainingBytes = totalBytes - currentTotalReceivedByte
                                const remainingTime = remainingBytes / averageSpeed

                                const progress = {
                                    progress: currentTotalReceivedByte * 100 / totalBytes,
                                    speed: _bytesToSize(averageSpeed) + '/sec',
                                    remainingBytes: remainingBytes,
                                    remaining: _bytesToSize(remainingBytes),
                                    totalBytes: totalBytes,
                                    total: _bytesToSize(totalBytes),
                                    remainingTime: _timeHumanReadable(remainingTime),
                                    downloadedBytes: currentTotalReceivedByte,
                                    downloaded: _bytesToSize(currentTotalReceivedByte),
                                }	

                                queueItem.onProgress(progress, item);
                                
                                prevReceivedTime = currentTime
                                prevTotalReceivedByte = currentTotalReceivedByte
                            }
            });

            item.on('done', (e, state) => {

                let finishedDownloadCallback = queueItem.callback || function () {};

                if (!win.isDestroyed()) {
                    win.setProgressBar(-1);
                }

                if (state === 'interrupted') {
                    const message = `The download of ${item.getFilename()} was interrupted`;

                    finishedDownloadCallback(new Error(message), { url: item.getURL(), filePath });

                } else if (state === 'completed') {
                    if (process.platform === 'darwin') {
                        app.dock.downloadFinished(filePath);
                    }

                    // TODO: remove this listener, and/or the listener that attach this listener to newly created windows
                    // if (opts.unregisterWhenDone) {
                    //     webContents.session.removeListener('will-download', listener);
                    // }

                    finishedDownloadCallback(null, { url: item.getURL(), filePath });

                }

            });
        }
    };

    win.webContents.session.on('will-download', listener);
}

const register = (opts = {}) => {

    app.on('browser-window-created', (e, win) => {
        _registerListener(win, opts);
    });
};

const download = (options, callback) => {
    let win = BrowserWindow.getFocusedWindow() || lastWindowCreated;
    options = Object.assign({}, { path: '' }, options);

    const request = net.request(options.url);
    
    const filename = decodeURIComponent(path.basename(options.url));
    const url = decodeURIComponent(options.url);

    const folder = options.downloadFolder || downloadFolder
    const filePath = path.join(folder, options.path.toString(), filename.split(/[?#]/)[0])

    if (options.headers) {
        options.headers.forEach((h) => { request.setHeader(h.name, h.value) })

        // Modify the user agent for all requests to the following urls.
        const filter = {
            urls: [options.url]
        }

        session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
            options.headers.forEach((h) => { details.requestHeaders[h.name] =  h.value })
            // details.requestHeaders['User-Agent'] = 'MyAgent'
            callback({ cancel: false, requestHeaders: details.requestHeaders })
        })
    }

    if (typeof options.onLogin === 'function') {
        request.on('login', options.onLogin)
    }

    request.on('error', function (error) {
        let finishedDownloadCallback = callback || function () { };

        const message = `The request for ${filename} was interrupted: ${error}`;

        finishedDownloadCallback(new Error(message), { url: options.url, filePath: filePath });
    });

    request.on('response', function (response) {
        request.abort();

        queue.push({
            url: url,
            filename: filename,
            downloadFolder: options.downloadFolder,
            path: options.path.toString(),
            callback: callback,
            onProgress: options.onProgress
        });


        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);

            const fileOffset = stats.size;

            let serverFileSize = parseInt(response.headers['content-length']);
            if(serverFileSize === 1){
              serverFileSize = parseInt(response.headers['content-range'].split(" ")[1].split("/")[1])
            }

            console.log(filename + ' exists, verifying file size: (' + fileOffset + ' / ' + serverFileSize + ' downloaded)');

            // Check if size on disk is lower than server
            if (fileOffset < serverFileSize) {
                console.log('File needs re-downloaded as it was not completed');

                options = {
                    path: filePath,
                    urlChain: [options.url],
                    offset: parseInt(fileOffset),
                    length: serverFileSize,
                    lastModified: response.headers['last-modified']
                };

                win.webContents.session.createInterruptedDownload(options);

            } else {

                console.log(filename + ' verified, no download needed');

                let finishedDownloadCallback = callback || function () {};

                finishedDownloadCallback(null, { url, filePath });
            }

        } else {
            console.log(filename + ' does not exist, download it now');
            win.webContents.downloadURL(options.url);
        }
    });
    request.end();
};

const bulkDownload = (options, callback) => {

    options = Object.assign({}, { urls: [], path: '' }, options);

    let urlsCount = options.urls.length;
    let finished = [];
    let errors = [];

    options.urls.forEach((url) => {
        download({ url, path: options.path, onProgress: options.onProgress }, function (error, itemInfo) {

            if (error) {
                errors.push(itemInfo.url);
            } else {
                finished.push(itemInfo.url);
            }

            let errorsCount = errors.length;
            let finishedCount = finished.length;

            if (typeof options.onResult === 'function') {
                options.onResult(finishedCount, errorsCount, error, itemInfo.url);
            }

            if ((finishedCount + errorsCount) === urlsCount) {
                if (errorsCount > 0) {
                    callback(new Error(errorsCount + ' downloads failed'), finished, errors);
                } else {
                    callback(null, finished, []);
                }
            }
        });
    });
};

module.exports = {
    register,
    download,
    bulkDownload
};
