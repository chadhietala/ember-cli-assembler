/* global module, escape */
'use strict';

var SilentError  = require('ember-cli/lib/errors/silent');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var upstreamMergeTrees = require('broccoli-merge-trees');
var cleanBaseURL = require('ember-cli/lib/utilities/clean-base-url');
var escapeRegExp = require('ember-cli/lib/utilities/escape-regexp');
var Funnel = require('broccoli-funnel');
var Project = require('ember-cli/lib/models/project');
var preprocessors = require('ember-cli/lib/preprocessors');
var merge = require('lodash-node/modern/object/merge');
var defaults = require('lodash-node/modern/object/defaults');
var fs = require('fs');
var path = require('path');
var unwatchedTree = require('broccoli-unwatched-tree');
var configLoader = require('ember-cli/lib/broccoli/broccoli-config-loader');
var configReplace = require('ember-cli/lib/broccoli/broccoli-config-replace');
var ES6Modules = require('broccoli-es6Modules');
var preprocessJs  = preprocessors.preprocessJs;
var preprocessTemplates = preprocessors.preprocessTemplates;
var preprocessCss = preprocessors.preprocessCss;
var preprocessMinifyCss = preprocessors.preprocessMinifyCss;

function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);

  tree.description = options && options.description;

  return tree;
}

function Builder(options) {
  options = options || {};

  this._initProject(options);

  this.env  = Builder.env();
  this.name = options.name || this.project.name();
  this.registry = options.registry || preprocessors.defaultRegistry(this);

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this.vendorStaticStyles      = [];
  this.otherAssetPaths         = [];
  this._importTrees            = [];
  this.vendorTestStaticStyles  = [];
  this.trees = this.options.trees;

  preprocessors.setupRegistry(this);
  this._notifyAddonIncluded();
}

Builder.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

Builder.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

Builder.prototype._initOptions = function(options, isProduction) {
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

  // needs a deeper merge than is provided above
  this.options.outputPaths = merge(this.options.outputPaths, {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    },
    testSupport: {
      css: '/assets/test-support.css',
      js: {
        testSupport: '/assets/test-support.js',
        testLoader: '/assets/test-loader.js'
      }
    }
  }, defaults);

  this.options.sourcemaps = merge(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  }, defaults);

  this.options.trees = merge(this.options.trees, {
    app:       'app',
    tests:     'tests',
    // these are contained within app/ no need to watch again
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

Builder.prototype._notifyAddonIncluded = function() {
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

Builder.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

Builder.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = configLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = new Funnel(configTree, {
    srcDir: '/',
    destDir: this.name + '/config'
  });

  return this._cachedConfigTree;
};

Builder.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

Builder.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    content.push(fs.readFileSync(path.join(__dirname,'..', 'node_modules/ember-cli/lib/broccoli/app-config-from-meta.js')));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

Builder.prototype.contentFor = function(config, match, type) {
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

Builder.prototype._contentForAppBoot = function(content, config) {
  content.push('if (runningTests) {');
  content.push('  require("' +
    config.modulePrefix +
    '/tests/test-helper");');
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


Builder.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

Builder.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var files = [
    'index.html'
  ];

  var index = new Funnel(this.trees.app, {
    files: files,
    getDestinationPath: function(relativePath) {
      if (relativePath === 'index.html') {
        relativePath = htmlName;
      }
      return relativePath;
    },
    description: 'Funnel: index.html'
  });

  return configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  });
};

Builder.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      return addon.treeFor(type);
    }
  }, this).filter(Boolean);
};

Builder.prototype._addonTree = function _addonTree() {
  if (this._cachedAddonTree) {
    return this._cachedAddonTree;
  }

  var addonTrees = mergeTrees(this.addonTreesFor('addon'), {
    overwrite: true,
    description: 'TreeMerger (addons)'
  });

  var addonES6 = new Funnel(addonTrees, {
    srcDir: 'modules',
    allowEmpty: true,
    description: 'Funnel: Addon JS'
  });

  // it is not currently possible to make Esperanto processing
  // pre-existing AMD a no-op, so we have to remove the reexports
  // to then merge them later :(
  var addonReexports = new Funnel(addonTrees, {
    srcDir: 'reexports',
    allowEmpty: true,
    description: 'Funnel: Addon Re-exports'
  });


  var transpiledAddonTree = new ES6Modules(addonES6, {
    description: 'ES6: Addon Trees',
    esperantoOptions: {
      absolutePaths: true,
      strict: true,
      _evilES3SafeReExports: this.options.es3Safe
    }
  });

  var reexportsAndTranspiledAddonTree = mergeTrees([
    transpiledAddonTree,
    addonReexports
  ], {
    description: 'TreeMerger: (re-exports)'
  });

  return this._cachedAddonTree = [
    addonTrees,
    reexportsAndTranspiledAddonTree
  ];
};

Builder.prototype._processedVendorTree = function() {
  if(this._cachedVendorTree) {
    return this._cachedVendorTree;
  }

  var trees = this._importTrees.slice();
  trees = trees.concat(this._addonTree());
  trees = trees.concat(this.addonTreesFor('vendor'));

  if (this.trees.vendor) {
    trees.push(this.trees.vendor);
  }

  var mergedVendor = mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerger (vendor)'
  });

  this._cachedVendorTree = new Funnel(mergedVendor, {
    srcDir: '/',
    destDir: 'vendor/'
  });

  return this._cachedVendorTree;
};

Builder.prototype._processedExternalTree = function() {
  if (this._cachedExternalTree) {
    return this._cachedExternalTree;
  }

  var vendor = this._processedVendorTree();
  var trees = [vendor];

  return this._cachedExternalTree = mergeTrees(trees, {
    description: 'TreeMerger (ExternalTree)'
  });
};

Builder.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

Builder.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  var podPatterns = this._podTemplatePatterns();
  var excludePatterns = podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);

  return this._cachedFilterAppTree = new Funnel(this.trees.app, {
    exclude: excludePatterns,
    description: 'Funnel: Filtered App'
  });
};

Builder.prototype._processedAppTree = function() {
  var addonTrees = this.addonTreesFor('app');
  var mergedApp  = mergeTrees(addonTrees.concat(this._filterAppTree()), {
    overwrite: true,
    description: 'TreeMerger (app)'
  });

  return new Funnel(mergedApp, {
    srcDir: '/',
    destDir: this.name
  });
};

Builder.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var mergedTrees = this.trees.templates ? addonTrees.concat(this.trees.templates) : addonTrees;
  var mergedTemplates = mergeTrees(mergedTrees, {
    overwrite: true,
    description: 'TreeMerger (templates)'
  });

  var standardTemplates = new Funnel(mergedTemplates, {
    srcDir: '/',
    destDir: this.name + '/templates'
  });

  var podTemplates = new Funnel(this.trees.app, {
    include: this._podTemplatePatterns(),
    exclude: [ /^templates/ ],
    destDir: this.name + '/',
    description: 'Funnel: Pod Templates'
  });

  return preprocessTemplates(mergeTrees([standardTemplates, podTemplates]), {
    registry: this.registry,
    description: 'TreeMerger (pod & standard templates)'
  });
};

Builder.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;
  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });
  return workingTree;
};

Builder.prototype.addonLintTree = function(type, tree) {
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

Builder.prototype._processedTestsTree = function() {
  var addonTrees  = this.addonTreesFor('test-support');
  var mergedTests = mergeTrees(addonTrees.concat(this.trees.tests), {
    overwrite: true,
    description: 'TreeMerger (tests)'
  });

  return new Funnel(mergedTests, {
    srcDir: '/',
    destDir: this.name + '/tests'
  });
};

Builder.prototype._addAppTests = function(sourceTrees) {
  if (this.tests) {
    var tests = this._processedTestsTree();
    var preprocessedTests = preprocessJs(tests, '/tests', this.name, {
      registry: this.registry
    });

    sourceTrees.push(this.addonPostprocessTree('test', preprocessedTests));

    if (this.hinting) {
      var jshintedApp = this.addonLintTree('app', this._filterAppTree());
      var jshintedTests = this.addonLintTree('tests', this.trees.tests);

      jshintedApp = new Funnel(jshintedApp, {
        srcDir: '/',
        destDir: this.name + '/tests/'
      });

      jshintedTests = new Funnel(jshintedTests, {
        srcDir: '/',
        destDir: this.name + '/tests/'
      });

      sourceTrees.push(jshintedApp);
      sourceTrees.push(jshintedTests);
    }
  }
};

Builder.prototype.appAndDependencies = function() {
  var app       = this._processedAppTree();
  var templates = this._processedTemplatesTree();
  var config    = this._configTree();

  if (!this.registry.availablePlugins['ember-cli-babel'] && this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var external        = this._processedExternalTree();
  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);
  var sourceTrees = [
    external,
    postprocessedApp,
    templates,
    config
  ];

  this._addAppTests(sourceTrees);

  var emberCLITree = this._processedEmberCLITree();

  sourceTrees.push(emberCLITree);

  return mergeTrees(sourceTrees, {
    overwrite: true,
    description: 'TreeMerger (appAndDependencies)'
  });
};

Builder.prototype._processedEmberCLITree = function() {
  if (this._cachedEmberCLITree) {
    return this._cachedEmberCLITree;
  }

  var files = [
    'vendor-prefix.js',
    'vendor-suffix.js',
    'app-prefix.js',
    'app-suffix.js',
    'app-boot.js',
    'test-support-prefix.js',
    'test-support-suffix.js'
  ];

  var emberCLITree = configReplace(unwatchedTree(__dirname), this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: files,
    patterns: this._configReplacePatterns()
  });

  return this._cachedEmberCLITree = new Funnel(emberCLITree, {
    files: files,
    srcDir: '/',
    destDir: '/vendor/ember-cli/'
  });
};

Builder.prototype.javascript = function() {
  var applicationJs = this.appAndDependencies();

  var appJs = new ES6Modules(
    new Funnel(applicationJs, {
      include: [new RegExp('^' + escapeRegExp(this.name + '/') + '.*\\.js$')],
      description: 'Funnel: App JS Files'
    }),

    {
      description: 'ES6: App Tree',
      esperantoOptions: {
        absolutePaths: true,
        strict: true,
        _evilES3SafeReExports: this.options.es3Safe
      }
    }
  );

  return mergeTrees([
    appJs,
    this._processedEmberCLITree()
  ], {
    description: 'TreeMerger (appJS  & processedEmberCLITree)'
  });
};

Builder.prototype._configReplacePatterns = function() {
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

Builder.prototype.otherAssets = function() {
  var external = this._processedExternalTree();
  var otherAssetTrees = this.otherAssetPaths.map(function (path) {
    return new Funnel(external, {
      srcDir: path.src,
      files: [path.file],
      destDir: path.dest
    });
  });
  return mergeTrees(otherAssetTrees, {
    description: 'TreeMerger (otherAssetTrees)'
  });
};

Builder.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public');

  if (this.trees.public) {
    trees.push(this.trees.public);
  }

  return mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerge (public)'
  });
};

Builder.prototype.styles = function() {
  if (fs.existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var addonTrees = this.addonTreesFor('styles');
  var external = this._processedExternalTree();
  var styles = new Funnel(this.trees.styles, {
    srcDir: '/',
    destDir: '/app/styles'
  });

  var trees = [external].concat(addonTrees);
  trees.push(styles);

  var stylesAndVendor = mergeTrees(trees, {
    description: 'TreeMerger (stylesAndVendor)',
    overwrite: true
  });

  var options = { outputPaths: this.options.outputPaths.app.css };
  options.registry = this.registry;
  var preprocessedStyles = preprocessCss(stylesAndVendor, '/app/styles', '/assets', options);

 // TODO not sure if we should concat these or not
 // var vendorStyles = this.concatFiles(stylesAndVendor, {
 //   inputFiles: this.vendorStaticStyles.concat(['vendor/addons.css']),
 //   outputFile: this.options.outputPaths.vendor.css,
 //   description: 'Concat: Vendor Styles'
 // });

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
   // vendorStyles  = preprocessMinifyCss(vendorStyles, options);
  }

  //var mergedTrees = mergeTrees([
  //    preprocessedStyles,
  //    vendorStyles
  //  ], {
  //    description: 'styles'
  //  });
  return this.addonPostprocessTree('css', preprocessedStyles);
};

Builder.prototype.toArray = function() {
  return [
    this.index(),
    this.javascript(),
    this.otherAssets(),
    this.publicTree()
  ];
};

Builder.prototype.toTree = function(additionalTrees) {
  return this.toArray().concat(additionalTrees || []);
};

Builder.env = function() {
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

module.exports = Builder;
