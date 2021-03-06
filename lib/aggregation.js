'use strict';

var _ = require('lodash');

var internals = {};

/**
 * Returns the default mapper for a specified agg type
 * @param {string} aggType
 * @return {*|_.identity}
 */
internals.mapper = function (aggType) {
    switch (aggType) {
        case 'terms':
        case 'geohash_grid':
            return Aggregation.bucketReducer(function (bucket, value) {
                return _.assign({ count: bucket.doc_count }, value);
            });
        case 'histogram':
            return Aggregation.bucketMapper(function (bucket, value) {
                return _.assign({ value: bucket.key, count: bucket.doc_count }, value);
            });
        case 'date_histogram':
            return Aggregation.bucketMapper(function (bucket, value) {
                return _.assign({ date: bucket.key_as_string, count: bucket.doc_count }, value);
            });
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'value_count':
            return Aggregation.valuePlucker();
    }
    return _.identity;
};

/**
 * Creates an aggregate body builder
 * @param {string} aggType the agg type (e.g. 'terms', 'sum', etc)
 * @param {function =} parse an optional parser for user-supplied strings (e.g. Aggregation.sum('amount') --> { sum: { field: amount }}
 * @return {Function}
 */
internals.wrap = function(aggType, parse) {
    parse = parse || function(field) {
            return { field: field };
        };

    return function(body) {
        return _.set({}, aggType, _.isString(body) ? parse(body) : body);
    };
};

/**
 * Represents a node in an elasticsearch query aggregation tree. Aggregation instances assist in recursively building
 * the query payload and then parsing the response into a more useful data structure
 * @param body
 * @constructor
 */
function Aggregation(body) {
    // e.g. { terms: { field: 'amount' }}
    this.body = body || {};

    // child aggs
    this.aggs = {};
}

/**
 * Builds the query payload for consumption by elasticsearch.
 * <code>
 *  var queryBody = {};
 *  queryBody.aggregations = agg.build().aggregations;
 * </code>
 * @return {*}
 */
Aggregation.prototype.build = function() {
    var payload = _.clone(this.body);
    if (_.keys(this.aggs).length) {
        payload.aggregations = _.mapValues(this.aggs, function (agg) {
            return agg.build();
        });
    }
    return payload;
};

/**
 * Visits a node for recursive configuration
 * @param visitor
 * @return {Aggregation}
 */
Aggregation.prototype.visit = function(visitor) {
    if (_.isFunction(visitor)) visitor(this);

    return this;
};

/**
 * Adds a child aggregate to the tree
 * @param {string} name the name of the aggregation
 * @param {{}} body the agg body - typically built with Aggregation.x() static builder functions
 * @param {function=} callback a visitor callback to assist in recursive configuration
 * @return {Aggregation}
 *
 * <code>
 *     new Aggregation().aggregation('states', Aggregation.terms('state'), function(agg) {
 *         agg
 *          .aggregation('total_amount', Aggregation.sum('amount')) // add child sum
 *          .mapper(function(result, agg) {
 *              // can override default result.buckets reducer here
 *          });
 *     });
 * </code>
 */
Aggregation.prototype.aggregation = function(name, body, callback) {
    this.aggs[name] = new Aggregation(body)
        .mapper(internals.mapper(_.keys(body)[0]))
        .visit(callback);

    return this;
};

// shorthand
Aggregation.prototype.agg = Aggregation.prototype.aggregation;

/**
 * Default aggregation mapper that maps the root aggregation values. Designed to be overridden per child type
 * @param result
 * @param agg
 * @private
 */
Aggregation.prototype._map = function(result, agg) {
    return _.mapValues(agg.aggs, function (agg, key) {
        return agg.map(result.aggregations && result.aggregations[key]);
    });
};

/**
 * Maps over the elastic search result by recursing through the aggregate tree
 * @param result
 */
Aggregation.prototype.map = function(result) {
    return this._map(result, this);
};

Aggregation.prototype.mapBucket = function(bucketMapper) {
    this._mapBucket = bucketMapper;
};

/**
 * Sets the mapper function
 * @param mapper
 * @return {Aggregation}
 */
Aggregation.prototype.mapper = function(mapper) {
    this._map = mapper;
    return this;
};

/**
 * Configures the embedded aggregation body
 * @param config
 * @return {Aggregation}
 */
Aggregation.prototype.configure = function(config) {
    _.values(this.body).forEach(function (value) {
        _.assign(value, config);
    });

    return this;
};

exports.Aggregation = Aggregation;

// shorthand builder functions
Aggregation.terms = internals.wrap('terms');
Aggregation.stats = internals.wrap('stats');
Aggregation.sum = internals.wrap('sum');
Aggregation.avg = internals.wrap('avg');
Aggregation.max = internals.wrap('max');
Aggregation.min = internals.wrap('min');
Aggregation.percentiles = internals.wrap('percentiles');
Aggregation.valueCount = internals.wrap('value_count');
Aggregation.extendedStats = internals.wrap('extended_stats');
Aggregation.histogram = internals.wrap('histogram');
Aggregation.geohashGrid = internals.wrap('geohash_grid');
Aggregation.dateHistogram = internals.wrap('date_histogram', function(field) {
    return { field: field, interval: 'month' };
});

/**
 * An aggregation result mapper that reduces a bucketed aggregation by applying iterator to the mapped result of each child bucket
 * @param {function} iterator a function accepting value and bucket
 * @return {Function}
 */
Aggregation.bucketReducer = function(iterator) {
    iterator = iterator || _.identity;

    return function(result, agg) {
        return result.buckets.reduce(function (acc, bucket) {
            var value = _.reduce(agg.aggs, function (acc, agg, key) {
                acc[key] = agg.map(bucket[key]);
                return acc;
            }, {});
            acc[bucket.key] = iterator(bucket, value);
            return acc;
        }, {});
    };
};

/**
 * Maps buckets
 * @param iterator
 * @return {Function}
 */
Aggregation.bucketMapper = function(iterator) {
    iterator = iterator || _.identity;

    return function(result, agg) {
        return result.buckets.map(function (bucket) {
            var value = _.reduce(agg.aggs, function (acc, agg, key) {
                acc[key] = agg.map(bucket[key]);
                return acc;
            }, {});
            return iterator(bucket, value);
        });
    };
};

/**
 * An aggregation result mapper that plucks a value property
 * @param iterator
 * @return {Function}
 */
Aggregation.valuePlucker = function(iterator) {
    iterator = iterator || _.identity;

    return function(result) {
        return iterator(result.value);
    };
};