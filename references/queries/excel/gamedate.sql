--drop view vw_gamedate;
--create view vw_gamedate as
SELECT DATEtime('2025-01-01', '+' || cast(g.GameTime/60/60/24 as varchar) || ' DAY') as GameDate FROM fct_game as g order by g.GameID desc limit 1
--1597613610.0
--SELECT DATEtime('2025-01-01', '+' || cast(27162000.0/60/60/24 as varchar) || ' DAY') as GameDate FROM fct_game as g order by g.GameID desc limit 1