/* global module, escape */
'use strict';

var SilentError = require('silent-error');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var upstreamMergeTrees = require('broccoli-merge-trees');
var cleanBaseURL = require('clean-base-url');
var TreeDescriptor = require('ember-cli-tree-descriptor');
var Cache = require('./cache');
// TODO: this is now passed in
var Project = require('ember-cli/lib/models/project');
// TODO: this actually need to be passed in
var preprocessors = require('ember-cli-preprocess-registry/preprocessors');
var merge = require('lodash-node/modern/object/merge');
var defaults = require('merge-defaults');
var fs = require('fs');
var path = require('path');
var unwatchedTree = require('broccoli-unwatched-tree');
var configLoader = require('ember-cli/lib/broccoli/broccoli-config-loader');
var configReplace = require('ember-cli/lib/broccoli/broccoli-config-replace');
var babel = require('broccoli-babel-transpiler');
var stew = require('broccoli-stew');
var funnel = require('broccoli-funnel');
var amdNameResolver = require('amd-name-resolver');
var loadPath = require('./load-path');
var chalk = require('chalk');
var existsSync = require('exists-sync');
var walkSync = require('walk-sync');
var preprocessJs  = preprocessors.preprocessJs;
var preprocessTemplates = preprocessors.preprocessTemplates;
var preprocessCss = preprocessors.preprocessCss;
var preprocessMinifyCss = preprocessors.preprocessMinifyCss;
var isType = preprocessors.isType;
var rename = stew.rename;
var mv = stew.mv;
var find = stew.find;
var rm = stew.rm;

function Assembler(options) {
  options = options || {};

  this._initProject(options);

  this.env  = Assembler.env();
  this.name = options.name || this.project.name();
  this.registry = options.registry || preprocessors.defaultRegistry(this);

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  var entries = options.entries || [this.name, this.testPath];
  options.entries = this.concatEntries(entries);
  this._initOptions(options, isProduction);
  this.entries = options.entries;
  this.trees = this.options.trees;
  this.testPath = this.name + '/' + this.trees.tests;
  this._importTrees = [];
  this.legacyFilesToAppend = [];
  this.legacyTestFilesToAppend = [];
  this.vendorStaticStyles = [];
  this.vendorTestStaticStyles = [];
  this.otherAssetPaths = [];
  this.cache = new Cache();

  this.entries = this.options.entries;


  // @deprecated
  this.bowerDirectory = this.project.bowerDirectory;

  preprocessors.setupRegistry(this);
  this._notifyAddonIncluded();
}

Assembler.prototype.concatEntries = function(entries) {
  if (Array.isArray(entries)) {
    return entries;
  } else if (typeof entries === 'string') {
    return [entries];
  } else {
    return [this.name];
  }
};

Assembler.prototype.import = function(asset, options) {
  var assetPath = this._getAssetPath(asset);

  if (!assetPath) {
    return;
  }

  options = defaults(options || {}, {
    type: 'vendor',
    prepend: false
  });

  var directory    = path.dirname(assetPath);
  var subdirectory = directory.replace(new RegExp('^vendor/|' + this.bowerDirectory), '');
  var extension    = path.extname(assetPath);

  if (!extension) {
    throw new Error('You must pass a file to `app.import`. For directories specify them to the constructor under the `trees` option.');
  }

  this._importAssetTree(directory, subdirectory, options.destDir, assetPath);
  this._import(
    assetPath,
    options,
    directory,
    subdirectory,
    extension
  );
};


/**
  @private
  @method _import
  @param {String} assetPath
  @param {Object} options
  @param {String} directory
  @param {String} subdirectory
  @param {String} extension
 */
Assembler.prototype._import = function(assetPath, options, directory, subdirectory, extension) {
  var basename = path.basename(assetPath);
  if (isType(assetPath, 'js', {registry: this.registry})) {
    if(options.type === 'vendor') {
      options.path = assetPath;

      if (options.exports) {
        options.files = Object.keys(options.exports);
      }

      if (options.prepend) {
        this.legacyFilesToAppend.unshift(options);
      } else {
        this.legacyFilesToAppend.push(options);
      }
    } else if (options.type === 'test' ) {
      this.legacyTestFilesToAppend.push(assetPath);
    } else {
      throw new Error( 'You must pass either `vendor` or `test` for options.type in your call to `app.import` for file: '+basename );
    }
  } else if (extension === '.css') {
    if(options.type === 'vendor') {
      this.vendorStaticStyles.push(assetPath);
    } else {
      this.vendorTestStaticStyles.push(assetPath);
    }
  } else {
    var destDir = options.destDir;
    if (destDir === '') {
      destDir = '/';
    }
    this.otherAssetPaths.push({
      src: directory,
      file: basename,
      dest: destDir || subdirectory
    });
  }
};

Assembler.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

/**
  @private
  @method _importAssetTree
  @param {String} directory
  @param {String} subdirectory
 */
Assembler.prototype._importAssetTree = function(directory, subdirectory, destDir, assetPath) {
  if (existsSync(directory) && this._importTrees.indexOf(directory) === -1) {
    var tree = new funnel(directory, {
      srcDir: '/',
      destDir: destDir ? destDir : '/legacy' + subdirectory
    });

    var legacyDesc = new TreeDescriptor({
      name: assetPath,
      treeType: 'legacy',
      tree: tree,
      root: path.join(process.cwd(), assetPath)
    });

    this.cache.set(directory, legacyDesc);
  }
};

/**
  @private
  @method _getAssetPath
  @param {(Object|String)} asset
  @return {(String|undefined)} assetPath
 */
Assembler.prototype._getAssetPath = function(asset) {
  /** @type {String} */
  var assetPath;

  if (typeof asset === 'object') {
    if (this.env in asset) {
      assetPath = asset[this.env];
    } else {
      assetPath = asset.development;
    }
  } else {
    assetPath = asset;
  }

  if (!assetPath) {
    return;
  }

  assetPath = assetPath.replace(path.sep, '/');

  if (assetPath.split('/').length < 2) {
    console.log(chalk.red('Using `app.import` with a file in the root of `vendor/` causes a significant performance penalty. Please move `'+ assetPath + '` into a subdirectory.'));
  }

  if (/[\*\,]/.test(assetPath)) {
    throw new Error('You must pass a file path (without glob pattern) to `app.import`.  path was: `' + assetPath + '`');
  }

  return assetPath;
};

Assembler.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

Assembler.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

Assembler.prototype._initOptions = function(options, isProduction) {
  var guranteedTypes = [this.name, this.testPath, 'shared'];
  var engines = options.entries.filter(function(entry) {
    return guranteedTypes.indexOf(entry) < 0;
  });

  this.options = merge(options, {
    es3Safe: true,
    storeConfigInMeta: true,
    autoRun: true,
    outputPaths: {},
    minifyCSS: {
      enabled: !!isProduction,
      options: { relativeTo: 'app/styles' }
    },
    minifyJS: {
      enabled: !!isProduction,
    },
    sourcemaps: {},
    trees: {},
    jshintrc: {},
    'ember-cli-qunit': {
      disableContainerStyles: false
    }
  }, defaults);

  var defaultOutputPaths = {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    tests: {
      js: '/assets/'+ this.name + '-tests.js'
    },
    shared: {
      js: '/assets/shared.js'
    },
    testSupport: {
     css: '/assets/test-support.css',
     js: {
       testSupport: '/assets/test-support.js',
       testLoader: '/assets/test-loader.js'
     }
   },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    }
  };

  engines.forEach(function(engine) {
    defaultOutputPaths[engine] = {
      js: '/assets/' + engine + '.js',
      css: {
        'engine': '/assets/' + engine + '.css'
      }
    };
  });

  this.options.outputPaths = merge(this.options.outputPaths, defaultOutputPaths, defaults);

  this.options.sourcemaps = merge(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  }, defaults);

  this.options.trees = merge(this.options.trees, {
    app:       'app',
    tests:     'tests',
    styles:    unwatchedTree('app/styles'),
    templates: fs.existsSync('app/templates') ? unwatchedTree('app/templates') : null,
    vendor: fs.existsSync('vendor') ? unwatchedTree('vendor') : null,
    public: fs.existsSync('public') ? 'public' : null
  }, defaults);

  this.options.jshintrc = merge(this.options.jshintrc, {
    app: this.project.root,
    tests: path.join(this.project.root, 'tests'),
  }, defaults);
};

Assembler.prototype._notifyAddonIncluded = function() {
  this.initializeAddons();
  this.project.addons = this.project.addons.filter(function(addon) {
    addon.app = this;

    if (!addon.isEnabled || addon.isEnabled()) {

      if (addon.included) {
        addon.included(this);
      }

      return addon;
    }
  }, this);
};

Assembler.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

Assembler.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = configLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = mv(configTree, this.name + '/config');
  return this._cachedConfigTree;
};

Assembler.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

Assembler.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    var lib = require.resolve('ember-cli').replace('cli/index.js', '');
    content.push(fs.readFileSync( lib + 'broccoli/app-config-from-meta.js'));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

Assembler.prototype.contentFor = function(config, match, type) {
  var content = [];

  switch (type) {
    case 'head':          this._contentForHead(content, config);         break;
    case 'config-module': this._contentForConfigModule(content, config); break;
    case 'app-boot':      this._contentForAppBoot(content, config);      break;
  }

  content = this.project.addons.reduce(function(content, addon) {
    var addonContent = addon.contentFor ? addon.contentFor(type, config) : null;
    if (addonContent) {
      return content.concat(addonContent);
    }

    return content;
  }, content);

  return content.join('\n');
};

Assembler.prototype._contentForAppBoot = function(content, config) {
  content.push('if (runningTests) {');
  content.push('  require("' +
    config.modulePrefix +
    '/tests/index");');
  if (this.options.autoRun) {
    content.push('} else {');
    content.push('  require("' +
      config.modulePrefix +
      '/app")["default"].create(' +
      calculateAppConfig(config) +
      ');');
  }
  content.push('}');
};

Assembler.prototype.testIndex = function() {
  var tree = mv(configReplace(this.trees.tests, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ 'index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  }));

  var testDesc = new TreeDescriptor({
    name: this.testPath,
    tree: rename(tree, function(relativePath) {
      return 'tests' + path.sep + relativePath;
    }),
    treeType: 'index',
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.testPath, testDesc);
};

Assembler.prototype.testFiles = function() {
  var testemTree = unwatchedTree(path.join(__dirname, '..', 'node_modules/ember-cli/lib/broccoli'));

  var tree = funnel(testemTree, {
    files: ['testem.js']
  });


  if (this.options.fingerprint && this.options.fingerprint.exclude) {
    this.options.fingerprint.exclude.push('testem');
  }

  var testemDesc = new TreeDescriptor({
    name: this.testPath,
    treeType: 'testem',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.testPath, testemDesc);
};

Assembler.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var index = rename(this.trees.app, function(relativePath) {
    return relativePath === 'index.html' ? htmlName : relativePath;
  });

  var tree = mv(configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  }), '/');

  var descriptor = new TreeDescriptor({
    name: this.name,
    treeType: 'index',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.name, descriptor);
};

/**
 * Checks to see if the addon actually contains files
 * @param  {Object} addon An addon model
 * @param  {String} type  The type of tree we are verifing
 * @return {Boolean}
 */
Assembler.prototype._implementsTreeType = function(addon, type) {
  if (addon.treePaths && addon.treePaths[type]) {
    var typePath = path.join(addon.root, addon.treePaths[type]);

    if (existsSync(typePath)) {
      return walkSync(typePath).filter(function(relativePath) {
        return relativePath !== '.gitkeep';
      }).length > 0;
    } else {
      return false;
    }
  }

  return false;
};

Assembler.prototype._fileTypesInTree = function(addon, type) {
  var typePath = path.join(addon.root, addon.treePaths[type]);
  if (existsSync(typePath)) {
    return uniq(walkSync(typePath).filter(byFile).map(byExtension));
  }

  return [];
};

Assembler.prototype.createAddonDescriptor = function(addon, type) {
  if (addon.treeFor) {
    if (this._implementsTreeType(addon, type)) {
      var tree = addon.treeFor(type);
      var hasTreeOfType = this.cache.get(addon.name) && this.cache.get(addon.name).trees[type];
      if (!hasTreeOfType) {

        var descriptor = new TreeDescriptor({
          name: addon.name,
          tree: tree,
          treeType: type,
          packageName: addon.pkg.name,
          pkg: addon.pkg,
          nodeModulesPath: addon.nodeModulesPath,
          root: addon.root
        });

        this.cache.set(addon.name, descriptor);
      }
    }
  }
};

Assembler.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      this.createAddonDescriptor(addon, type);
      return addon.treeFor(type);
    }
  }, this).filter(Boolean);
};

Assembler.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

Assembler.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  return this._cachedFilterAppTree = find(this.trees.app, {
    exclude: this._filterStylesAndTemplates()
  });
};

Assembler.prototype._filterStylesAndTemplates = function() {
  var podPatterns = this._podTemplatePatterns();
  return podPatterns.concat([
    new RegExp('.*\.html'),
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);
};

Assembler.prototype._filteredAddonAppDir = function() {
  this.addonTreesFor('app');
  return this.cache.descriptorsByType('app').map(function(descriptor) {
    descriptor.trees.app = find(descriptor.trees.app, {
      exclude: this._filterStylesAndTemplates()
    });
    this.cache.set(descriptor.name, descriptor);

    return descriptor.trees.app;
  }, this);
};

// Merges an addons app directory with the consuming app
Assembler.prototype._processedAppTree = function() {
  var filteredAddons = this._filteredAddonAppDir().concat(this._filterAppTree());
  return mv(mergeTrees(filteredAddons, {
    overwrite: true,
    description: 'TreeMerger (app)'
  }), this.name);
};

Assembler.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var addonPodTemplates = find(this.cache.treesByType('app'), 'pods/**/template.*');
  var mergedTrees = this.trees.templates ? addonTrees.concat(this.trees.templates) : addonTrees;
  var mergedTemplates = mergeTrees(mergedTrees, {
    overwrite: true,
    description: 'TreeMerger (templates)'
  });

  var standardTemplates = mv(mergedTemplates, this.name + '/templates');

  var podTemplates = mv(find(mergeTrees([addonPodTemplates, this.trees.app], {
    overwrite: true
  }), {
    include: this._podTemplatePatterns(),
    exclude: [ /^templates/ ]
  }), this.name + '/');

  var templates = preprocessTemplates(mergeTrees([standardTemplates, podTemplates]), {
    registry: this.registry,
    description: 'TreeMerger (pod & standard templates)'
  });

  return this.addonPreprocessTree('templates', templates);
};

Assembler.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;
  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });
  return workingTree;
};

Assembler.prototype.addonLintTree = function(type, tree) {
  var output = [];
  this.project.addons.forEach(function(addon) {
    if (addon.lintTree) {
      output.push(addon.lintTree(type, tree));
    }
  });
  return mergeTrees(output,{
    overwrite: true,
    description: 'TreeMerger (lint)'
  });
};


/**
  Runs addon postprocessing on a given tree and returns the processed tree.
  This enables addons to do process immediately **before** the preprocessor for a
  given type is run, but before concatenation occurs.  If an addon wishes to
  apply a transform  after the preprocessors run, they can instead implement the
  postprocessTree hoo.
  To utilize this addons implement `postprocessTree` hook.
  An example, would be to remove some set of files before the preprocessors run.
  ```js
  var stew = require('broccoli-stew');
  module.exports = {
    name: 'my-cool-addon',
    preprocessTree: function(type, tree) {
      if (type === 'js' && type === 'template') {
        return stew.rm(tree, someGlobPattern);
      }
      return tree;
    }
  }
  ```
  @private
  @method addonPreprocessTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
*/
Assembler.prototype.addonPreprocessTree = function(type, tree) {
  var workingTree = tree;

  this.project.addons.forEach(function(addon) {
    if (addon.preprocessTree) {
      workingTree = addon.preprocessTree(type, workingTree);
    }
  });

  return workingTree;
};

Assembler.prototype.appJavascript = function() {
  var app = this.addonPreprocessTree('js', this._processedAppTree());
  var templates = this._processedTemplatesTree();

  if (this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  // TODO move this to the packager
  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);

  var appTreeDescriptor = new TreeDescriptor({
    name: this.name,
    packageName: this.project.pkg.name,
    nodeModulesPath: this.project.nodeModulesPath,
    root: this.project.root,
    treeType: 'app',
    tree: mergeTrees([postprocessedApp, templates]),
    pkg: this.project.pkg
  });

  this.cache.set(this.name, appTreeDescriptor);
  return this.cache.get(this.name);
};

Assembler.prototype._processedTestsTree = function() {
  return mv(find(this.trees.tests, '**/*.js'), this.name);
};

Assembler.prototype.appTests = function() {
  if (this.tests) {
    var tests = this.addonPreprocessTree('test', this._processedTestsTree());
    var preprocessedTests = preprocessJs(tests, '/tests', this.testPath, {
      registry: this.registry
    });

    var aliases = {};
    aliases[this.testPath] = {
      name: this.name,
      treeType: 'tests'
    };

    var testTreeDesc = new TreeDescriptor({
      name: this.testPath,
      packageName: this.project.pkg.name,
      nodeModulesPath: this.project.nodeModulesPath,
      tree: preprocessedTests,
      root: this.project.root,
      aliases: aliases,
      treeType: 'tests',
      pkg: this.project.pkg
    });

    this.cache.set(this.testPath, testTreeDesc);
    return this.cache.get(this.testPath);
  }
};

Assembler.prototype.packagerFiles = function() {
  var envFilePath = this.name + '/config/environment.js';
  var packager = '__packager__';
  var loaderTree = rename(this.cache.get('loader.js').trees.addon, function() {
    return 'loader.js';
  });

  // Evict the loader as we merge it into the packager files
  this.cache.remove('loader.js');

  var files = [
    'environment.js',
    'vendor-prefix.js',
    'vendor-suffix.js',
    'app-prefix.js',
    'app-suffix.js',
    'app-boot.js',
    'test-support-prefix.js',
    'test-support-suffix.js'
  ];

  var inputTree = unwatchedTree(path.join(__dirname, '..', 'node_modules/ember-cli/lib/broccoli'));

  var packagerFiles = configReplace(inputTree, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: files,
    patterns: this._configReplacePatterns()
  });

  packagerFiles = funnel(mergeTrees([packagerFiles, loaderTree]), {
    srcDir: '/',
    destDir: '/' + packager
  });

  var envFile = rename(find(packagerFiles, { include: [packager + '/environment.js'] }), function() {
    return envFilePath;
  });

  packagerFiles = rm(packagerFiles, packager + '/environment.js');

  var envTreeDescriptor = new TreeDescriptor({
    name: envFilePath,
    tree: envFile,
    treeType: 'environment',
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  var packageDescriptor = new TreeDescriptor({
    name: packager,
    treeType: 'packager',
    tree: packagerFiles,
    root: null,
    nodeModulesPath: null,
    pkg: null,
    packageName: packager
  });

  this.cache.set(packager, packageDescriptor);
  this.cache.set('environment', envTreeDescriptor);
};

Assembler.prototype.vendor = function() {
  this.cache.descriptorsByType('vendor').forEach(function(descriptor) {
    descriptor.trees.app = rename(descriptor.trees.app, function(relativePath) {
      return 'vendor/' + relativePath;
    });
    this.cache.set(descriptor.name, descriptor);
  }, this);
};

Assembler.prototype._mergeBabelOptions = function () {
  var defaultBabelOptions = {
    modules: 'amdStrict',
    moduleIds: true,
    exportModuleMetadata: true,
    sourceMaps: true,
    resolveModuleSource: amdNameResolver
  };
  var babelOptions = this.options.babel || {};

  this.babelOptions = defaults(babelOptions, defaultBabelOptions);

  return this.babelOptions;
};

Assembler.prototype.transpileTree = function(tree) {
  var babelOptions = this._mergeBabelOptions();

  return new babel(tree, babelOptions);
};

Assembler.prototype.populateCacheForJavascript = function() {
  this.addonTreesFor('vendor');
  this.addonTreesFor('addon');
  this.addonTreesFor('dist');
  this.addonTreesFor('test-support');
};

Assembler.prototype.javascript = function() {
  this.populateCacheForJavascript();
  this.packagerFiles();

  var cache = this.cache;
  var envFile = cache.get('environment');
  var appJavascript = this.appJavascript();
  var appTests = this.appTests();

  appJavascript.trees.app = this.transpileTree(
    mergeTrees([appJavascript.trees.app, envFile.trees.environment])
  );

  cache.set(this.name, appJavascript);
  cache.remove('environment');

  if (appTests) {
    appTests.trees.tests = this.transpileTree(appTests.trees.tests);
    cache.set(this.testPath, appTests);
  }

  cache.descriptorsByType('addon').forEach(function(descriptor) {
    descriptor.trees.addon = this.transpileTree(loadPath(descriptor.trees.addon, { name: descriptor.name }));
    cache.set(descriptor.name, descriptor);
  }, this);

};

Assembler.prototype._configReplacePatterns = function() {
  return [{
    match: /\{\{EMBER_ENV\}\}/g,
    replacement: calculateEmberENV
  }, {
    match: /\{\{content-for ['"](.+)["']\}\}/g,
    replacement: this.contentFor.bind(this)
  }, {
    match: /\{\{MODULE_PREFIX\}\}/g,
    replacement: calculateModulePrefix
  }];
};

Assembler.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public').concat(this.trees.public ? this.trees.public : []);
  var tree = mv(mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerger (public)'
  }), '/');

  var publicDesc = new TreeDescriptor({
    name: this.name,
    treeType: 'public',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.name, publicDesc);
};

Assembler.prototype.styles = function() {
  if (this._processedStylesTree) {
    return this._processedStylesTree;
  }

  if (fs.existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var styleTrees = [];
  styleTrees = styleTrees.concat(
    this.addonTreesFor('styles'),
    this.trees.styles
  );

  var styles = mergeTrees(styleTrees, {
    description: 'TreeMerger (stylesAndAddons)',
    overwrite: true
  });

  var options = { outputPaths: this.options.outputPaths.app.css };

  options.registry = this.registry;

  var preprocessedStyles = preprocessCss(styles, '/', this.name, options);

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
  }

  var styleDesc = new TreeDescriptor({
    name: this.name,
    treeType: 'styles',
    tree: rename(preprocessedStyles, function(relativePath) {
      var file = relativePath.replace(path.extname(relativePath), '');

      if (relativePath === 'app.css') {
        return this.options.outputPaths.app.css.app;
      } else if (this.options.outputPaths.app.css[file]) {
        return this.options.outputPaths.app.css[file];
      }

      return relativePath;
    }.bind(this)),
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  // Evict styles as the were merged above
  this.cache.descriptorsByType('styles').forEach(function(desc) {
    this.cache.remove(desc.name);
  }, this);

  this.cache.set(this.name, styleDesc);
};

/**
 * Evicts addons that are now resident pieces to Ember CLI build pipeline
 * @return {Nil}
 */
Assembler.prototype.evictLegacyAddons = function() {
  this.registry.remove('javascript', 'ember-cli-babel');
};

Assembler.prototype.assemble = function() {
  this.evictLegacyAddons();
  this.index();
  this.javascript();
  this.vendor();
  this.publicTree();
  this.styles();
  this.testIndex();
  this.testFiles();
  return this.cache;
};

Assembler.env = function() {
  return process.env.EMBER_ENV || 'development';
};

function calculateBaseTag(config){
  var baseURL      = cleanBaseURL(config.baseURL);
  var locationType = config.locationType;

  if (locationType === 'hash') {
    return '';
  }

  if (baseURL) {
    return '<base href="' + baseURL + '" />';
  } else {
    return '';
  }
}

function calculateEmberENV(config) {
  return JSON.stringify(config.EmberENV || {});
}

function calculateModulePrefix(config) {
  return config.modulePrefix;
}

function calculateAppConfig(config) {
  return JSON.stringify(config.APP || {});
}


function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);
  tree.description = options && options.description;
  return tree;
}


function byFile(relativePath) {
  return relativePath.splice(-1) !== '/';
}

function byExtension(relativePath) {
  return path.extname(relativePath);
}

function uniq(array) {
  return array.filter(function(item, i, self) {
    return self.indexOf(item) === i;
  });
}

module.exports = Assembler;
