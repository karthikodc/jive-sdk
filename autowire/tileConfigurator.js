/*
 * Copyright 2013 Jive Software
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

var fs = require('fs'),
    q  = require('q'),
    jive = require('../api');

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Private

var isValidFile = function(file ) {
    return !(file.indexOf('.') == 0)
};

/**
 * Returns a promise when defintion tasks, life cycle events,
 * and other things in the service directory have been processed.
 * @param definition
 * @param svcDir
 * @return {*}
 */
function processServices( definition, svcDir ) {
    /////////////////////////////////////////////////////
    // apply tile specific tasks, life cycle events, etc.

    return q.nfcall(fs.readdir, svcDir ).then( function(tilesDirContents) {

        var tasks = [];
        var events = [];

        // add in the base event handlers
        events = events.concat(jive.events.baseEvents);

        // analyze the directory contents, picking up tasks and events
        tilesDirContents.forEach(function(item) {
            if ( isValidFile(item) ) {
                var theFile = svcDir + '/' + item;
                var target = require(theFile);

                // task
                var task = target.task;
                if ( task ) {
                    var taskToAdd = task;
                    if (typeof task === 'function' ) {
                        // its a function, create a wrapping task object
                        taskToAdd = jive.tasks.build( task );
                    }

                    // enforce a standard key
                    taskToAdd.setKey( definition.name  + '.' + item + "." + taskToAdd.getInterval() );
                    tasks.push( taskToAdd );
                }

                // event handler
                if ( target.eventHandlers ) {
                    events = events.concat( target.eventHandlers );
                }
            }
        });

        // add the event handlers
        events.forEach( function( handlerInfo ) {
            jive.extstreams.definitions.addEventHandler( definition.name, handlerInfo['event'], handlerInfo['handler'] );
        });

        // add the tasks
        jive.extstreams.definitions.addTasks( tasks );
    });
}

/**
 * Returns a promise when all the tile routes have been calculated for a particular tile directory.
 * @param tileInfo
 * @return {*}
 */
function addTileRoutesToApp(app, tileInfo){
    var promises = [];

    tileInfo.routes.forEach( function( currentRoute ) {
        if ( !isValidFile(currentRoute) ) {
            return;
        }

        //Look in the routes directory for the current tile.
        //for each file that is in there that matches an http verb, add it to the app as a route
        var currentTileDir = tileInfo.routePath + '/' + currentRoute;
        promises.push(q.nfcall(fs.readdir, currentTileDir).then( function(verbDirs){
            verbDirs.forEach(function(httpVerbFile){
                if ( !isValidFile(httpVerbFile) ) {
                    return;
                }

                var httpVerb = httpVerbFile.substring(0, httpVerbFile.length - 3);
                var routeHandlerPath = (currentTileDir + '/' + httpVerb);
                var routeContextPath = ('/' + tileInfo.currentTile + '/' + currentRoute);

                console.log('Tile route added for ', tileInfo.currentTile, ': ', routeContextPath, ' -> ', routeHandlerPath );
                var routeHandler = require(routeHandlerPath);
                if (typeof app[httpVerb] == 'function') {
                    app[httpVerb](routeContextPath, routeHandler.route);
                }
            });
        }));
    });

    // convert the collected promises into a single promise that returns when they're all successfull
    return q.all(promises);
}

function fsexists(path) {
    var deferred = q.defer();
    fs.exists( path, function(exists ) {
        deferred.resolve(exists);
    });

    return deferred.promise;
}

/**
 * Returns a promise for detecting when the tile directory has been autowired.
 * @param app
 * @param tileDir
 */
function configureOneTileDir( app, tileDir ) {
    var tile = tileDir.substring( tileDir.lastIndexOf('/') + 1, tileDir.length ); /// xxx todo this might not always work!
    var definitionPath = tileDir + '/definition.json';
    var servicesPath = tileDir + '/services';
    var routesPath = tileDir + '/routes';

    return q.nfcall( fs.readFile, definitionPath).then( function(data ) {
        var definition = JSON.parse(data);
        definition.id = definition.id === '{{{tile_id}}}' ? null : definition.id;
        return definition;
    }).then( function(definition) {

        var promises = [];

        var r = fsexists(routesPath).then( function(exists) {
            if ( exists ) {
                return q.nfcall(fs.readdir, routesPath)
                    // process the routes
                    .then( function(routesToAdd) {
                        return addTileRoutesToApp( app, { "routePath" : routesPath, "routes":routesToAdd, "currentTile":tile} )
                });
            }
        });

        promises.push(r);

        var s = fsexists(servicesPath).then( function(exists) {
            if ( exists ) {
                return processServices( definition, servicesPath );
            }
        });

        promises.push(s);

        var apiToUse = definition['style'] === 'ACTIVITY' ?  jive.extstreams.definitions : jive.tiles.definitions;

        return q.all(promises).then( jive.util.makePromise(apiToUse.save(definition).execute).then( function() {
            console.log("Done configuring", definition.name );
        }));
    } )
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// public

exports.configureOneTileDir = configureOneTileDir;

/**
 * Autowires each tile discovered in the provided tiles directory.
 * @param app
 * @param tilesDir
 * @return {*}
 */
exports.configureTilesDir = function( app, tilesDir, callback ) {
    //Find the tiles by walking the tileDir tree
    return q.nfcall(fs.readdir, tilesDir).then(function(tilesDirContents){
        var proms = [];
        tilesDirContents.forEach(function(item) {
            if ( !isValidFile(item) ) {
                return;
            }
            var tileDirPath = tilesDir + '/' + item ;
            proms.push(configureOneTileDir(app, tileDirPath));
        });

        return q.all(proms).then(function(){
            //We've added all the routes for the tiles and actions throw the event that indicates we are done
            console.log("Finished tiles directory config");
            app.emit('event:jiveTileConfigurationComplete', app);
            if ( callback ) {
                callback();
            }
        });
    }).done();
};

