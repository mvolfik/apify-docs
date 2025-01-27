const util = require('util');
const fs = require('fs');
const path = require('path');
const metadataParser = require('markdown-yaml-metadata-parser');
const _ = require('underscore');
const crypto = require('crypto');

const { PAGE_EXT, ALLOWED_METADATA_KEYS } = require('./consts');

const readdirPromised = util.promisify(fs.readdir);
const lstatPromised = util.promisify(fs.lstat);
const readFilePromised = util.promisify(fs.readFile);

// Create the page object that will form the index.json file
const readAndParsePage = async (fullPath, shortPath, sourceDirName) => {
    const rawPage = (await readFilePromised(fullPath)).toString();
    const { content, metadata } = metadataParser(rawPage);

    // Check that there are no invalid keys.
    const invalidKeys = _.without(Object.keys(metadata), ...ALLOWED_METADATA_KEYS);
    if (invalidKeys.length) throw new Error(`Invalid metadata keys found: ${invalidKeys.join(', ')}, allowed keys: ${ALLOWED_METADATA_KEYS.join(', ')}`); // eslint-disable-line
    if (!metadata.title) throw new Error(`Value metadata.title is missing in ${fullPath}`);
    if (!metadata.paths || !Array.isArray(metadata.paths)) {
        throw new Error(`Metadata.paths missing or not an Array in ${fullPath}.`);
    }

    // Check if the path based on filename is in the metadata.paths array
    const filenamePath = shortPath.replace('/home.md', '').replace('.md', '').replace(/_/g, '-');
    if (!_.includes(metadata.paths, filenamePath)) throw new Error(`Metadata.paths in ${fullPath} is missing path "${filenamePath}"`);

    // Check that metadata.description is 140-160 characters long (for SEO)
    if (metadata.description) {
        const descriptionLength = metadata.description.length;
        if (descriptionLength < 120 || descriptionLength > 160) {
            console.error(`Description in ${filenamePath}.md too ${descriptionLength < 120 ? 'short' : 'long'} (${descriptionLength}). `
                + 'It should be between 120 and 160 characters for best SEO. \n');
        }
    }

    // Return Object with filenamePath removed from paths to avoid
    // redirect loop on the website
    return {
        ..._.omit(metadata, 'paths'),
        menuTitle: metadata.menuTitle || metadata.title,
        content,
        contentHash: crypto.createHash('sha256').update(content).digest('base64'),
        sourceUrl: `https://apify-docs.s3.amazonaws.com/master/${sourceDirName}/pages/${shortPath}`,
        path: filenamePath,
        redirectPaths: metadata.paths.filter((p) => p !== filenamePath),
    };
};

const identifyFilesAndDirectories = async (currentPath, items, sourceDirPath) => {
    const filePaths = [];
    const dirPaths = [];

    const promises = items.map(async (item) => {
        const itemPath = currentPath ? path.join(currentPath, item) : item;
        const itemFullPath = path.join(sourceDirPath, itemPath);
        const stat = await lstatPromised(itemFullPath);

        if (stat.isDirectory()) {
            // Check if the directory has a corresponding overview (.md) file and exit with error if not
            // This does not apply to the `images` or `api_v2` dirs
            if (
                item !== 'images'
                && item !== 'api_v2'
                && !items.includes(`${item}.md`)
            ) {
                throw new Error(`The directory "${item}" doesn't have a corresponding overview file "${item}.md". This will break the menu.`
                    + `\nPlease, add an overview for this section.`);
            }

            dirPaths.push(itemPath);
        } else filePaths.push(itemPath);
    });
    await Promise.all(promises);

    return { filePaths, dirPaths };
};

/**
 * Go through all the files in a path and create the object that is used in the index.json file in build
 * This is the file that will be fetched when displaying the content
 * Return an object
 * @param {string} sourceDirPath
 * @param {string} sourceDirName
 * @param {string} currentPath
 * @returns {object}
 */
const traverseAllFiles = async (sourceDirPath, sourceDirName, currentPath = null) => {
    const currentFullPath = currentPath ? path.join(sourceDirPath, currentPath) : sourceDirPath;
    const directoryContent = await readdirPromised(currentFullPath);

    const pages = {};
    const assets = {};

    const { filePaths, dirPaths } = await identifyFilesAndDirectories(currentPath, directoryContent, sourceDirPath);

    const filePromises = filePaths.map(async (filePath) => {
        const isPage = filePath.split('.').pop() === PAGE_EXT;

        if (isPage) {
            pages[filePath] = await readAndParsePage(path.join(sourceDirPath, filePath), filePath, sourceDirName);
        } else {
            assets[filePath] = `https://apify-docs.s3.amazonaws.com/master/${sourceDirName}/assets/${filePath}`;
        }
    });

    const dirPromises = dirPaths.map(async (dirPath) => {
        const { pages: itemPages, assets: itemAssets } = await traverseAllFiles(sourceDirPath, sourceDirName, dirPath);
        Object.assign(pages, itemPages);
        Object.assign(assets, itemAssets);
    });

    await Promise.all(filePromises.concat(dirPromises));

    return { pages, assets };
};

// Check and validate the links to other docs pages and assets on each page
const replacePaths = (index) => {
    Object.keys(index.pages).forEach((pagePath) => {
        const pageDef = index.pages[pagePath];

        const linkMatches = pageDef.content.match(/\{\{@link\s[^}]+\}\}/g);
        if (linkMatches) {
            linkMatches.forEach((linkMatch) => {
                const linkedPageParts = linkMatch
                    .substr(8, linkMatch.length - 10)
                    .split('#');
                const linkedPage = linkedPageParts[0];
                // TODO check if the target anchor exists in the linked page
                const linkedPageTarget = linkedPageParts[1] ? `#${linkedPageParts[1]}` : '';
                const linkedPageDef = index.pages[linkedPage];
                if (!linkedPageDef) throw new Error(`Page ${pagePath} contains invalid link ${linkMatch}!`);
                pageDef.content = pageDef.content.replace(linkMatch, `/${linkedPageDef.path}${linkedPageTarget}`);
            });
        }

        const assetMatches = pageDef.content.match(/\{\{@asset\s[^}]+\}\}/g);
        if (assetMatches) {
            assetMatches.forEach((assetMatch) => {
                const linkedAsset = assetMatch.substr(9, assetMatch.length - 11);
                if (!index.assets[linkedAsset]) throw new Error(`Page ${pagePath} contains invalid asset ${assetMatch}!`);
                pageDef.content = pageDef.content.replace(assetMatch, `/${linkedAsset}`);
            });
        }
    });
};

module.exports = {
    traverseAllFiles,
    replacePaths,
};
