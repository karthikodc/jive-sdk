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

var jive = require('../../api');
var kue = require('kue');
var express = require('express');
var q = require('q');

var jobs;
var redisClient;

jobQueueName = 'work';

function Scheduler() {
    redisClient = require('redis').createClient();
    jobs = kue.createQueue();
    jobs.promote();
    console.log("Redis Scheduler Initialized for queue");
}

module.exports = Scheduler;

/**
 * Schedule a task.
 * @param eventID the named event to fire to perform this task
 * @param context arguments to provide to the event handler
 * @param interval optional, time until this event should be fired again
 *
 * Returns a promise that gets invoked when the scheduled task has completed execution
 * only if its not a recurrent task
 */
Scheduler.prototype.schedule = function schedule(eventID, context, interval) {
    var deferred;

    if ( !interval ) {
        deferred = q.defer();
    }

    var meta = {};

    var jobID = jive.util.guid();
    meta['jobID'] = jobID;
    meta['eventID'] = eventID;
    meta['context'] = context;
    if (interval) {
        meta['interval'] = interval;
    }
    jobs.create(jobQueueName, meta).on('complete', function() {
        if ( !deferred ) {
            // we're done if there is no promise to fulfill (e.g. tile pushes)
            return;
        }

        // there is a promise to fulfill:
        // once the job is done, retrieve any results that were cached on redis by some worker
        // then resolve or reject the promise accordingly.
        // todo: destroy result stored under jobID in redis
        // so we don't hold onto old results ... maybe this is a reaper task? or we
        // do it inline here?

        redisClient.get(jobID, function(err, jobResult) {
            if ( !err ) {
                deferred.resolve( jobResult ? JSON.parse(jobResult)['result'] : null );
            } else {
                if ( !jobResult ) {
                    deferred.resolve();
                } else {
                    var parsed = JSON.parse(jobResult);
                    if ( parsed['err'] ) {
                        deferred.reject(  parsed['err'] );
                    } else {
                        deferred.resolve( parsed['result']);
                    }
                }
            }
        });
    }).save();

    jive.logger.debug("Scheduled task: " + eventID, interval || '(no interval)');

    if (deferred) {
        return deferred.promise;
    }
};

Scheduler.prototype.unschedule = function unschedule(eventID){
    this.getTasks().forEach(function(job) {
        if (job.data['eventID'] == eventID) {
            job.remove();
        }
    });
};

Scheduler.prototype.isScheduled = function(eventID) {
    var deferred = q.defer();
    this.getTasks().forEach(function(job) {
        if (job.data['eventID'] == eventID) {
            deferred.resolve(true);
        }
    });
    return deferred.promise;
};

Scheduler.prototype.getTasks = function getTasks(){
    kue.Job.rangeByType(jobQueueName, 'delayed', 0, 10, 'asc', function (err, delayedJobs) {
        kue.Job.rangeByType(jobQueueName, 'inactive', 0, 10, 'asc', function (err, inactiveJobs) {
            return delayedJobs.concat(inactiveJobs);
        });
    });
};

Scheduler.prototype.shutdown = function(){
    var scheduler = this;
    this.getTasks().forEach(function(job){
        scheduler.unschedule(job);
    });
};