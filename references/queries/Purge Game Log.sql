WITH 
param AS 
(
	SELECT
		2 as YearsToKeep
)
/*
,CTE_GameTime as 
( 
	select 
		max(Time+0) as GameTime 
	from 
		FCT_GameLog as gl 
	inner join 
		const 
	on 
		gl.GameID = const.GameID 
)
*/

--select * from vw_const inner join CTE_GameTime on 1=1

--select count(*) from FCT_GameLog where ROWID in 
select count(*) from FCT_GameLog where ROWID not in 
--select count(*) from FCT_GameLog where GameID = (select GameID from vw_const) AND ROWID not in 
--delete from FCT_GameLog where ROWID not in
--delete from FCT_GameLog where GameID = (select GameID from vw_const) AND ROWID not in
(
	select gl.ROWID 
	from vw_const as c
	inner join param as p on 1 = 1
	inner join 
		 FCT_GameLog as gl 
	on 
		gl.GameID = c.GameID
	AND
		gl.Time >= c.GameTime - (p.YearsToKeep * 365 * 24 * 60 * 60)
	
)

--select min(gl.Time) from FCT_GameLog as gl where gl.GameID = 117
--select max(gl.Time) from FCT_GameLog as gl where gl.GameID = 117