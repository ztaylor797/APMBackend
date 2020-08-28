#!/usr/bin/env node
const pgp = require('pg-promise')({
        capSQL: true // generate capitalized SQL 
});    

function openDB() {
    const db = pgp({
        user: 'prod',
        host: 'localhost',
        database: 'apm'
        // password: 'secretpassword',
        // port: 3211,
    });
    // db.txcs = new pgp.helpers.ColumnSet(['col_a', 'col_b'], {table: 'tmp'});
    return db;
}

const db = openDB();

// our set of columns, to be created only once (statically), and then reused,
// to let it cache up its formatting templates for high performance:
const cs = new pgp.helpers.ColumnSet(['col_a', 'col_b'], {table: 'tmp'});

// console.log(db.txcs);

// data input values:
const values = [{col_a: 'a1', col_b: 'b1'}, {col_a: 'a2', col_b: 'b2'}];

// generating a multi-row insert query:
const query = pgp.helpers.insert(values, cs);

// executing the query:
db.none(query)
    .then(data => {
        // success, data = null
        console.info(`Insert successful`);
    })
    .catch(error => {
        // error;
        console.error(`Error during insert: ${error}`);
    })
    .finally(db.$pool.end);

